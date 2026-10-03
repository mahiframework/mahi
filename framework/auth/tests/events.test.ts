import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, EVENTS_TOKEN, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { EventDispatcher, RecordingEventDispatcher } from "@mahiframework/events";
import { Hasher, SIGNER_TOKEN, Signer } from "@mahiframework/encryption";
import { HttpError, HttpResponse, Request, Router } from "@mahiframework/http";
import { Hono } from "hono";
import { AuthManager } from "../src/auth-manager.js";
import { runWithAuth } from "../src/auth-context.js";
import { SessionGuard } from "../src/guards/session-guard.js";
import { TokenGuard } from "../src/guards/token-guard.js";
import { PasswordBroker } from "../src/passwords/password-broker.js";
import { EmailVerificationBroker } from "../src/verification/email-verification-broker.js";
import { csrf } from "../src/middleware/csrf.js";
import { ArraySessionStore } from "../src/session/array-session-store.js";
import type { Credentials, UserProvider } from "../src/user-provider.js";
import {
  Attempted,
  Authenticated,
  AuthEvent,
  CsrfTokenMismatch,
  CurrentDeviceLogout,
  EmailVerificationSent,
  EmailVerified,
  Failed,
  Login,
  Logout,
  OtherDeviceLogout,
  PasswordReset,
  PasswordResetLinkSent,
  TokenCreated,
  TokenRevoked,
} from "../src/events/index.js";
import { fireAuthEvent, safeCredentials } from "../src/events/fire-auth-event.js";
import { createTestDatabase, type TestDatabase } from "./__fixtures__/test-database.js";

interface TestUser {
  id: string;
  email: string;
  password: string;
  email_verified_at: string | null;
}

const ALICE_ID = "alice";

function makeUser(overrides: Partial<TestUser> = {}): TestUser {
  return {
    id: ALICE_ID,
    email: "alice@example.com",
    password: "hashed",
    email_verified_at: null,
    ...overrides,
  };
}

class StubUserProvider implements UserProvider<TestUser> {
  updated: string[] = [];

  constructor(
    private readonly user: TestUser,
    private readonly hasher?: Hasher,
  ) {}

  async retrieveById(id: string): Promise<TestUser | null> {
    return id === this.user.id ? this.user : null;
  }

  async retrieveByCredentials(credentials: Credentials): Promise<TestUser | null> {
    return credentials["email"] === this.user.email ? this.user : null;
  }

  async validateCredentials(user: TestUser, credentials: Credentials): Promise<boolean> {
    if (this.hasher !== undefined) {
      return this.hasher.check(credentials["password"] ?? "", user.password);
    }

    return credentials["password"] === "correct-password";
  }

  async updatePassword(_user: TestUser, hashed: string): Promise<void> {
    this.updated.push(hashed);
  }
}

/**
 * Bind a recording dispatcher onto an application and make it current.
 *
 * The global registration is the mechanism under test, not test
 * convenience: `fireAuthEvent()` falls back to the ambient `app()`
 * because `SessionGuard`/`PasswordBroker` are constructed from a user
 * provider, a store and a signer, with no `Application` in reach.
 *
 * Takes an existing app so a suite that needs a database binds onto the
 * one `createTestDatabase()` already made current. Creating a second app
 * here and calling `setCurrentApp()` would silently shadow the first, and
 * every query would then fail on an unbound `DATABASE_TOKEN`.
 */
function withEvents(app: Application = new Application()): {
  app: Application;
  events: RecordingEventDispatcher;
} {
  const events = new RecordingEventDispatcher(app);
  app.instance(EVENTS_TOKEN, events);
  setCurrentApp(app);

  return { app, events };
}

/**
 * A signer bound at `SIGNER_TOKEN`, for the paths that mint signed URLs.
 *
 * `EmailVerificationBroker.verificationUrl()` resolves the signer from the
 * container rather than taking one, so a test exercising it needs the
 * binding even though the events themselves carry no URL.
 */
function bindSigner(app: Application): void {
  app.instance(SIGNER_TOKEN, new Signer(Buffer.alloc(32, 9)));
}

describe("auth events", () => {
  afterEach(() => {
    clearCurrentApp();
  });

  describe("fireAuthEvent", () => {
    it("is a no-op when no event dispatcher is bound", async () => {
      const app = new Application();

      // An application that never registered EventsServiceProvider must
      // still be able to authenticate. The soft guard is what keeps
      // `@mahiframework/events` an optional runtime concern even though it
      // is a compile-time dependency.
      await expect(fireAuthEvent(new Failed({ email: "a@b.c" }), app)).resolves.toBeUndefined();
    });

    it("is a no-op when there is no current application at all", async () => {
      clearCurrentApp();

      // A guard constructed in isolation, with no Application anywhere,
      // is a legitimate unit-test shape (every existing guard test does
      // it). `app()` throws in that state, so the helper must swallow
      // that rather than making auth depend on a bootstrapped container.
      await expect(fireAuthEvent(new Failed({ email: "a@b.c" }))).resolves.toBeUndefined();
    });

    it("propagates a throwing listener to the caller", async () => {
      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      app.instance(EVENTS_TOKEN, dispatcher);
      dispatcher.listen(Failed, () => {
        throw new Error("listener exploded");
      });

      // The deliberate divergence from queue's fireJobEvent(), which
      // swallows. A listener here can refuse an action by throwing, and
      // an audit listener that cannot write stops the act it failed to
      // record. The cost is that a buggy listener is an auth outage.
      await expect(fireAuthEvent(new Failed({ email: "a@b.c" }), app)).rejects.toThrow(
        "listener exploded",
      );
    });

    it("resolves the dispatcher per call, so a swapped fake is seen", async () => {
      const app = new Application();
      app.instance(EVENTS_TOKEN, new EventDispatcher(app));

      // Swap AFTER a dispatcher is already bound, the shape
      // createTestApplication({ fakeEvents: true }) produces. A cached
      // reference would keep pointing at the real dispatcher and every
      // assertDispatched() would fail.
      const fake = new RecordingEventDispatcher(app);
      app.instance(EVENTS_TOKEN, fake);

      await fireAuthEvent(new Failed({ email: "a@b.c" }), app);

      fake.assertDispatched(Failed);
    });
  });

  describe("safeCredentials", () => {
    it("strips the secret and keeps the identifier", () => {
      expect(safeCredentials({ email: "a@b.c", password: "hunter2" })).toEqual({
        email: "a@b.c",
      });
    });

    it("strips password_confirmation, which carries the same plaintext", () => {
      expect(
        safeCredentials({ email: "a@b.c", password: "x", password_confirmation: "x" }),
      ).toEqual({ email: "a@b.c" });
    });

    it("keeps a custom identifying column", () => {
      // A denylist, not an allowlist of known-safe keys: an allowlist
      // would silently drop `username` and make the event useless for an
      // app that keys on it.
      expect(safeCredentials({ username: "alice", password: "x" })).toEqual({
        username: "alice",
      });
    });

    it("matches secret keys case-insensitively", () => {
      expect(safeCredentials({ Password: "x", TOKEN: "y", email: "a@b.c" })).toEqual({
        email: "a@b.c",
      });
    });
  });

  describe("every event extends AuthEvent", () => {
    it("so one listener registration observes the whole subsystem", () => {
      const all = [
        new Attempted({}, true),
        new Authenticated("1", {}, "web"),
        new CsrfTokenMismatch("POST", "/x"),
        new CurrentDeviceLogout("1"),
        new EmailVerificationSent("1", "a@b.c", {}),
        new EmailVerified("1", "a@b.c", {}),
        new Failed({}),
        new Login("1", {}, "s", false, "web"),
        new Logout("1", {}, "s", "web"),
        new OtherDeviceLogout("1", "s", "web"),
        new PasswordReset("a@b.c", {}),
        new PasswordResetLinkSent("a@b.c", {}),
        new TokenCreated("1", "t", "login"),
        new TokenRevoked("t", null, false),
      ];

      for (const event of all) {
        expect(event).toBeInstanceOf(AuthEvent);
      }
    });

    it("names every event under the auth.* namespace", () => {
      // The name is what wildcard patterns match and what keys a queued
      // listener's id, so it must be an explicit static rather than the
      // class name a minifier is free to rewrite.
      expect(new Login("1", {}, "s", false, "web").eventName).toBe("auth.Login");
      expect(new Failed({}).eventName).toBe("auth.Failed");
      expect(new CsrfTokenMismatch("POST", "/x").eventName).toBe("auth.CsrfTokenMismatch");
    });

    it("is observable in bulk through the base class", async () => {
      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      app.instance(EVENTS_TOKEN, dispatcher);

      const seen: string[] = [];
      dispatcher.listen(AuthEvent, (event) => {
        seen.push(event.eventName);
      });

      await fireAuthEvent(new Failed({}), app);
      await fireAuthEvent(new Login("1", {}, "s", false, "web"), app);

      expect(seen).toEqual(["auth.Failed", "auth.Login"]);
    });

    it("is observable in bulk through an auth.* pattern", async () => {
      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      app.instance(EVENTS_TOKEN, dispatcher);

      const seen: string[] = [];
      dispatcher.listen("auth.*", (event) => {
        seen.push(event.eventName);
      });

      await fireAuthEvent(new TokenCreated("1", "t", "login"), app);

      expect(seen).toEqual(["auth.TokenCreated"]);
    });
  });

  describe("AuthManager.attempt", () => {
    let app: Application;
    let events: RecordingEventDispatcher;
    let hasher: Hasher;
    let user: TestUser;
    let manager: AuthManager;

    beforeEach(async () => {
      ({ app, events } = withEvents());
      hasher = new Hasher();
      user = makeUser({ password: await hasher.make("correct-horse") });

      manager = new AuthManager(
        app,
        { default: "token", guards: { token: { provider: "users" } }, providers: { users: {} } },
        hasher,
      );
      manager.extendUserProvider("database", () => new StubUserProvider(user, hasher));
    });

    it("dispatches Attempted with succeeded true on success", async () => {
      await manager.attempt({ email: user.email, password: "correct-horse" });

      events.assertDispatched(Attempted, (event) => event.succeeded && event.user === user);
    });

    it("dispatches Attempted and Failed on a wrong password", async () => {
      await manager.attempt({ email: user.email, password: "wrong" });

      events.assertDispatched(Attempted, (event) => !event.succeeded && event.user === null);
      events.assertDispatched(Failed);
    });

    it("dispatches Attempted and Failed for an unknown address", async () => {
      await manager.attempt({ email: "nobody@example.com", password: "whatever" });

      events.assertDispatched(Attempted, (event) => !event.succeeded);
      events.assertDispatched(Failed);
    });

    it("does not dispatch Failed on success", async () => {
      await manager.attempt({ email: user.email, password: "correct-horse" });

      events.assertNotDispatched(Failed);
    });

    it("never carries the password", async () => {
      await manager.attempt({ email: user.email, password: "correct-horse" });

      const [event] = events.dispatched(Attempted);
      expect(event?.credentials).toEqual({ email: user.email });
      expect(JSON.stringify(event)).not.toContain("correct-horse");
    });

    it("cannot distinguish an unknown account from a wrong password", async () => {
      await manager.attempt({ email: "nobody@example.com", password: "x" });
      await manager.attempt({ email: user.email, password: "wrong" });

      // Both failures must look identical on the wire, because attempt()
      // deliberately does not tell its caller which happened. An event
      // that leaked the difference would re-create at the event layer the
      // enumeration oracle the constant-work hash removes.
      const [first, second] = events.dispatched(Failed);
      expect(Object.keys(first?.credentials ?? {})).toEqual(Object.keys(second?.credentials ?? {}));
      expect(first?.guard).toBe(second?.guard);
    });
  });

  describe("AuthManager.resolve", () => {
    let app: Application;
    let events: RecordingEventDispatcher;
    let user: TestUser;
    let manager: AuthManager;

    beforeEach(() => {
      ({ app, events } = withEvents());
      user = makeUser();

      manager = new AuthManager(
        app,
        { default: "stub", guards: { stub: { provider: "users" } }, providers: { users: {} } },
        new Hasher(),
      );
      manager.extendUserProvider("database", () => new StubUserProvider(user));
      manager.extend("stub", () => ({
        async user() {
          return user;
        },
      }));
    });

    it("dispatches Authenticated for a resolved user", async () => {
      await runWithAuth({ user: null, guard: null }, async () => {
        await manager.resolve(Request.create("/"));
      });

      events.assertDispatched(
        Authenticated,
        (event) => event.userId === ALICE_ID && event.guard === "stub" && !event.viaActingAs,
      );
    });

    it("dispatches nothing for an anonymous request", async () => {
      manager.extend("stub", () => ({
        async user() {
          return null;
        },
      }));

      await runWithAuth({ user: null, guard: null }, async () => {
        await manager.resolve(Request.create("/"));
      });

      // An anonymous request is not an authentication event. A listener
      // wanting rejections watches Failed or the middleware's 401.
      events.assertNotDispatched(Authenticated);
    });

    it("marks an acting-as resolution so an audit log can exclude it", async () => {
      manager.actingAs(user);

      await runWithAuth({ user: null, guard: null }, async () => {
        await manager.resolve(Request.create("/"));
      });

      manager.actingAs(null);

      events.assertDispatched(Authenticated, (event) => event.viaActingAs);
    });

    it("dispatches once per request, not once per login", async () => {
      await runWithAuth({ user: null, guard: null }, async () => {
        await manager.resolve(Request.create("/"));
      });
      await runWithAuth({ user: null, guard: null }, async () => {
        await manager.resolve(Request.create("/"));
      });

      events.assertDispatchedTimes(Authenticated, 2);
    });

    it("skips the dispatch when the user object has no readable key", async () => {
      manager.extend("stub", () => ({
        async user() {
          return { email: "keyless@example.com" };
        },
      }));

      await runWithAuth({ user: null, guard: null }, async () => {
        // Resolution itself must still succeed: an unusual user source is
        // legal, and authentication cannot fail over telemetry.
        await expect(manager.resolve(Request.create("/"))).resolves.not.toBeNull();
      });

      events.assertNotDispatched(Authenticated);
    });
  });

  describe("SessionGuard", () => {
    let events: RecordingEventDispatcher;
    let user: TestUser;
    let guard: SessionGuard<TestUser>;
    let provider: StubUserProvider;

    function mount(): Hono {
      const hono = new Hono();
      const router = new Router(hono);

      router.post("/login", async (request) => {
        const id = await guard.login(request, ALICE_ID);

        return HttpResponse.json({ id });
      });
      router.post("/logout", async (request) => {
        await guard.logout(request);

        return HttpResponse.json({ ok: true });
      });
      router.post("/logout-others", async (request) => {
        const ok = await guard.logoutOtherDevices(request, String(request.input("password")));

        return HttpResponse.json({ ok });
      });

      return hono;
    }

    beforeEach(() => {
      ({ events } = withEvents());
      user = makeUser();
      provider = new StubUserProvider(user);
      guard = new SessionGuard(provider, new ArraySessionStore(), new Signer(Buffer.alloc(32, 7)), {
        name: "web",
        secure: false,
      });
    });

    it("dispatches Login after the session exists", async () => {
      await mount().request("/login", { method: "POST" });

      events.assertDispatched(
        Login,
        (event) =>
          event.userId === ALICE_ID &&
          event.user === user &&
          event.guard === "web" &&
          !event.remember &&
          event.sessionId.length > 0,
      );
    });

    it("reports the guard's config name, not the driver name", async () => {
      await mount().request("/login", { method: "POST" });

      // An app may configure two session guards ("web", "admin"); a
      // listener has to be able to tell which one logged someone in.
      events.assertDispatched(Login, (event) => event.guard === "web");
    });

    it("dispatches no Login when the user id resolves to nobody", async () => {
      await expect(guard.login(Request.create("/"), "ghost")).rejects.toThrow();

      events.assertNotDispatched(Login);
    });

    it("dispatches Logout carrying the ambient user", async () => {
      const hono = mount();
      const login = await hono.request("/login", { method: "POST" });
      const cookie = login.headers.get("set-cookie") ?? "";

      await runWithAuth({ user, guard: "web" }, async () => {
        await hono.request("/logout", { method: "POST", headers: { cookie } });
      });

      events.assertDispatched(
        Logout,
        (event) => event.userId === ALICE_ID && event.user === user && event.sessionId !== null,
      );
    });

    it("dispatches Logout with nulls when no user was ever resolved", async () => {
      const hono = mount();

      await hono.request("/logout", { method: "POST" });

      // A logout route without authenticate() has no ambient user, and
      // logout() deliberately does not load one just to fill an event.
      // A listener must tolerate this rather than assume.
      events.assertDispatched(
        Logout,
        (event) => event.userId === null && event.user === null && event.sessionId === null,
      );
    });

    it("dispatches CurrentDeviceLogout with the reason it was given", async () => {
      await guard.logoutEverywhere(ALICE_ID, "password_reset");

      events.assertDispatched(
        CurrentDeviceLogout,
        (event) => event.userId === ALICE_ID && event.reason === "password_reset",
      );
    });

    it("defaults the reason to requested", async () => {
      await guard.logoutEverywhere(ALICE_ID);

      events.assertDispatched(CurrentDeviceLogout, (event) => event.reason === "requested");
    });

    it("dispatches OtherDeviceLogout only on success", async () => {
      const hono = mount();
      const login = await hono.request("/login", { method: "POST" });
      const cookie = login.headers.get("set-cookie") ?? "";

      await hono.request("/logout-others", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      });

      // A failed password check destroyed nothing. Reporting it as a
      // logout would put a "you were signed out" row in an audit log for
      // an act that did not happen.
      events.assertNotDispatched(OtherDeviceLogout);

      await hono.request("/logout-others", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ password: "correct-password" }),
      });

      events.assertDispatched(OtherDeviceLogout, (event) => event.userId === ALICE_ID);
    });
  });

  describe("TokenGuard", () => {
    let db: TestDatabase;
    let events: RecordingEventDispatcher;
    let user: TestUser;
    let guard: TokenGuard<TestUser>;

    beforeEach(async () => {
      db = await createTestDatabase();
      ({ events } = withEvents(db.app));
      user = makeUser();
      guard = new TokenGuard(new StubUserProvider(user), { name: "api" });
    });

    afterEach(async () => {
      db.cleanup();
    });

    it("dispatches TokenCreated without the plaintext token", async () => {
      const { token } = await guard.createToken(ALICE_ID, "login");

      events.assertDispatched(
        TokenCreated,
        (event) => event.userId === ALICE_ID && event.name === "login" && event.guard === "api",
      );

      const [event] = events.dispatched(TokenCreated);
      const secret = token.split("|")[1] ?? "";
      // The plaintext IS the credential. An event carrying it would write
      // it into any audit row, log line or queued payload a listener
      // touches.
      expect(JSON.stringify(event)).not.toContain(secret);
    });

    it("dispatches TokenRevoked for a single token, with a null userId", async () => {
      const { record } = await guard.createToken(ALICE_ID, "login");
      events.reset();

      await guard.revokeToken(record.id);

      // revokeToken() takes only a token id and does not read the row it
      // deletes; adding a lookup purely to name an owner would put a
      // query in a revocation path.
      events.assertDispatched(
        TokenRevoked,
        (event) => event.tokenId === record.id && event.userId === null && !event.all,
      );
    });

    it("dispatches TokenRevoked with all set for a bulk revocation", async () => {
      await guard.createToken(ALICE_ID, "one");
      await guard.createToken(ALICE_ID, "two");
      events.reset();

      await guard.revokeAllTokens(ALICE_ID, "password_reset");

      events.assertDispatched(
        TokenRevoked,
        (event) =>
          event.all &&
          event.userId === ALICE_ID &&
          event.tokenId === null &&
          event.reason === "password_reset",
      );
    });
  });

  describe("PasswordBroker", () => {
    let db: TestDatabase;
    let events: RecordingEventDispatcher;
    let user: TestUser;
    let broker: PasswordBroker<TestUser>;
    let hasher: Hasher;

    beforeEach(async () => {
      db = await createTestDatabase();
      ({ events } = withEvents(db.app));
      hasher = new Hasher();
      user = makeUser();
      broker = new PasswordBroker<TestUser>(new StubUserProvider(user, hasher), hasher, {
        throttleSeconds: 0,
      });
    });

    afterEach(async () => {
      db.cleanup();
    });

    it("dispatches PasswordResetLinkSent for a real account", async () => {
      await broker.sendResetLink(user.email);

      events.assertDispatched(
        PasswordResetLinkSent,
        (event) => event.email === user.email && event.user === user,
      );
    });

    it("dispatches nothing for an unknown address", async () => {
      const result = await broker.sendResetLink("nobody@example.com");

      // The return value hides the distinction on purpose. An event firing
      // only for real accounts would re-create the enumeration oracle at
      // the event layer, where an audit row would record exactly what the
      // response shape works to conceal.
      expect(result.status).toBe("sent");
      events.assertNotDispatched(PasswordResetLinkSent);
    });

    it("never carries the reset token", async () => {
      const result = await broker.sendResetLink(user.email);
      const token = result.status === "sent" ? result.token : undefined;

      const [event] = events.dispatched(PasswordResetLinkSent);
      expect(token).toBeDefined();
      expect(JSON.stringify(event)).not.toContain(token ?? "@@none@@");
    });

    it("dispatches PasswordReset on success", async () => {
      const sent = await broker.sendResetLink(user.email);
      const token = sent.status === "sent" ? (sent.token ?? "") : "";
      events.reset();

      await expect(broker.reset(user.email, token, "new-password")).resolves.toEqual({
        status: "reset",
      });

      events.assertDispatched(
        PasswordReset,
        (event) => event.email === user.email && event.user === user,
      );
    });

    it("never carries the new password", async () => {
      const sent = await broker.sendResetLink(user.email);
      const token = sent.status === "sent" ? (sent.token ?? "") : "";
      await broker.reset(user.email, token, "super-secret-new");

      const [event] = events.dispatched(PasswordReset);
      expect(JSON.stringify(event)).not.toContain("super-secret-new");
    });

    it("dispatches nothing on a bad token", async () => {
      await broker.sendResetLink(user.email);
      events.reset();

      await expect(broker.reset(user.email, "not-the-token", "new")).resolves.toEqual({
        status: "invalid-token",
      });

      // A reset attempt with a bad token is indistinguishable from a
      // probe, and the broker burns a hash on that path precisely so it
      // reveals nothing.
      events.assertNotDispatched(PasswordReset);
    });

    it("still fires the legacy onPasswordReset callback", async () => {
      const seen: string[] = [];
      broker.onPasswordReset((event) => {
        seen.push(event.email);
      });

      const sent = await broker.sendResetLink(user.email);
      const token = sent.status === "sent" ? (sent.token ?? "") : "";
      await broker.reset(user.email, token, "new-password");

      // The callback predates these events and remains supported, so an
      // app already using it needs no change.
      expect(seen).toEqual([user.email]);
      events.assertDispatched(PasswordReset);
    });

    it("forwards password_reset as the revocation reason", async () => {
      const reasons: Array<string | undefined> = [];
      broker.revokesWith({
        sessions: {
          async destroyForUser(_id, reason) {
            reasons.push(reason);
          },
        },
        tokens: {
          async revokeAllTokens(_id, reason) {
            reasons.push(reason);
          },
        },
      });

      const sent = await broker.sendResetLink(user.email);
      const token = sent.status === "sent" ? (sent.token ?? "") : "";
      await broker.reset(user.email, token, "new-password");

      expect(reasons).toEqual(["password_reset", "password_reset"]);
    });
  });

  describe("EmailVerificationBroker", () => {
    let db: TestDatabase;
    let events: RecordingEventDispatcher;
    let user: TestUser;

    /**
     * The `hash` query parameter out of a verification URL.
     *
     * A query parameter, not a path segment: `verificationUrl()` signs
     * `{ id, hash }` into the query string, so reading the last path
     * segment yields the route itself and every verify() call returns
     * `invalid-hash`.
     */
    function hashFrom(result: { status: string; url?: string }): string {
      const url = result.status === "sent" ? (result.url ?? "") : "";

      return new URL(url, "http://localhost").searchParams.get("hash") ?? "";
    }

    function brokerFor(current: TestUser): EmailVerificationBroker<TestUser> {
      const model = {
        async update() {},
      } as unknown as ConstructorParameters<typeof EmailVerificationBroker>[1];

      return new EmailVerificationBroker<TestUser>(new StubUserProvider(current), model, {});
    }

    beforeEach(async () => {
      db = await createTestDatabase();
      ({ events } = withEvents(db.app));
      bindSigner(db.app);
      user = makeUser();
    });

    afterEach(async () => {
      db.cleanup();
    });

    it("dispatches EmailVerificationSent without the signed URL", async () => {
      const broker = brokerFor(user);
      const result = await broker.sendVerificationLink(ALICE_ID);
      const url = result.status === "sent" ? result.url : "";

      events.assertDispatched(
        EmailVerificationSent,
        (event) => event.userId === ALICE_ID && event.email === user.email,
      );

      // The URL is a capability: anyone holding it can verify the
      // address. The broker returns it to its caller, which delivers it.
      const [event] = events.dispatched(EmailVerificationSent);
      expect(url).toContain("signature");
      expect(JSON.stringify(event)).not.toContain("signature");
    });

    it("dispatches nothing for an already-verified address", async () => {
      const broker = brokerFor(makeUser({ email_verified_at: "2024-01-01T00:00:00.000Z" }));

      await expect(broker.sendVerificationLink(ALICE_ID)).resolves.toEqual({
        status: "already-verified",
      });

      events.assertNotDispatched(EmailVerificationSent);
    });

    it("dispatches EmailVerified on the transition only", async () => {
      const broker = brokerFor(user);
      const sent = await broker.sendVerificationLink(ALICE_ID);
      const hash = hashFrom(sent);
      events.reset();

      await expect(broker.verify(ALICE_ID, hash)).resolves.toEqual({ status: "verified" });

      events.assertDispatched(
        EmailVerified,
        (event) => event.userId === ALICE_ID && event.email === user.email,
      );
    });

    it("dispatches nothing when verifying an already-verified address", async () => {
      const broker = brokerFor(makeUser({ email_verified_at: "2024-01-01T00:00:00.000Z" }));
      const sent = await brokerFor(user).sendVerificationLink(ALICE_ID);
      const hash = hashFrom(sent);
      events.reset();

      await expect(broker.verify(ALICE_ID, hash)).resolves.toEqual({
        status: "already-verified",
      });

      // Nothing changed. Firing here would make a one-time "welcome,
      // you're verified" action run on every refresh of the page.
      events.assertNotDispatched(EmailVerified);
    });

    it("dispatches nothing for a stale hash", async () => {
      const broker = brokerFor(user);

      await expect(broker.verify(ALICE_ID, "0".repeat(40))).resolves.toEqual({
        status: "invalid-hash",
      });

      events.assertNotDispatched(EmailVerified);
    });
  });

  describe("csrf middleware", () => {
    let events: RecordingEventDispatcher;

    function mount(): Hono {
      const hono = new Hono();
      // Without an error handler a thrown HttpError surfaces as a 500 and
      // the assertion would be testing Hono's default, not the
      // middleware. Same harness the existing csrf suite uses.
      hono.onError((error) =>
        error instanceof HttpError
          ? Response.json({ error: error.message }, { status: error.status })
          : Response.json({ error: String(error) }, { status: 500 }),
      );
      const router = new Router(hono);
      router.use("*", csrf({ sign: false, secure: false }));
      router.post("/pay", async () => HttpResponse.json({ ok: true }));
      router.get("/form", async () => HttpResponse.json({ ok: true }));

      return hono;
    }

    beforeEach(() => {
      ({ events } = withEvents());
    });

    it("dispatches CsrfTokenMismatch before rejecting", async () => {
      const response = await mount().request("/pay", { method: "POST" });

      expect(response.status).toBe(403);
      events.assertDispatched(
        CsrfTokenMismatch,
        (event) => event.method === "POST" && event.path === "/pay",
      );
    });

    it("dispatches nothing for a safe method", async () => {
      await mount().request("/form");

      events.assertNotDispatched(CsrfTokenMismatch);
    });

    it("dispatches nothing when the token matches", async () => {
      const hono = mount();
      const form = await hono.request("/form");
      const cookie = form.headers.get("set-cookie") ?? "";
      const token = /XSRF-TOKEN=([^;]*)/.exec(cookie)?.[1] ?? "";

      const response = await hono.request("/pay", {
        method: "POST",
        headers: { cookie, "X-XSRF-TOKEN": decodeURIComponent(token) },
      });

      expect(response.status).toBe(200);
      events.assertNotDispatched(CsrfTokenMismatch);
    });
  });
});
