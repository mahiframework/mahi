import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Signer } from "@mahiframework/encryption";
import { HttpResponse, Router } from "@mahiframework/http";
import { createTestDatabase, type TestDatabase } from "../__fixtures__/test-database.js";
import { DatabaseSessionStore } from "../../src/session/database-session-store.js";
import type { Credentials, UserProvider } from "../../src/user-provider.js";
import { SessionGuard, LoginUserNotFoundError } from "../../src/guards/session-guard.js";
import { Request } from "@mahiframework/http";

interface TestUser {
  id: string;
  email: string;
}

const alice: TestUser = { id: "alice", email: "alice@example.com" };

class StubUserProvider implements UserProvider<TestUser> {
  async retrieveById(id: string): Promise<TestUser | null> {
    return id === alice.id ? alice : null;
  }
  async retrieveByCredentials(_c: Credentials): Promise<TestUser | null> {
    return null;
  }
  async validateCredentials(_user: TestUser, credentials: Credentials): Promise<boolean> {
    return credentials.password === "correct-password";
  }
}

/** Pull the cookie value a Set-Cookie response header would send back. */
function cookieFrom(response: Response, name = "session"): string | null {
  const header = response.headers.get("set-cookie");

  if (!header) {
    return null;
  }

  const match = new RegExp(`${name}=([^;]*)`).exec(header);
  const value = match?.[1];

  return value ? decodeURIComponent(value) : null;
}

/**
 * Mount a guard's routes on a real framework `Router`, NOT directly on
 * Hono with `c.json()`.
 *
 * This is the whole point of the harness: handlers here return platform
 * `Response` objects through the framework's own boundary, exactly as an
 * app's do. The previous version of this file registered handlers
 * straight onto Hono, which merges context-queued cookies for responses
 * it builds itself, so the suite passed while `login()` shipped no
 * cookie at all through a real Mahi route. Anything that only holds when
 * you bypass the router is not tested.
 */
function mount(guard: SessionGuard<TestUser>): Hono {
  const hono = new Hono();
  const router = new Router(hono);

  router.post("/login", async (request) => {
    const id = await guard.login(request, alice.id);

    return HttpResponse.json({ id });
  });
  router.post("/login-remember", async (request) => {
    const id = await guard.login(request, alice.id, { remember: true });

    return HttpResponse.json({ id });
  });
  router.get("/me", async (request) => {
    return HttpResponse.json({ user: await guard.user(request) });
  });
  router.post("/logout", async (request) => {
    await guard.logout(request);

    return HttpResponse.json({ ok: true });
  });
  router.post("/logout-others", async (request) => {
    const ok = await guard.logoutOtherDevices(request, String(request.input("password")));

    return HttpResponse.json({ ok });
  });
  router.post("/login-ghost", async (request) => {
    const id = await guard.login(request, "ghost");

    return HttpResponse.json({ id });
  });
  router.get("/session-id", (request) => {
    return HttpResponse.json({ sessionId: guard.sessionId(request) });
  });
  router.get("/session-remaining", async (request) => {
    return HttpResponse.json({ remaining: await guard.sessionLifetimeRemaining(request) });
  });

  return hono;
}

describe("SessionGuard", () => {
  let database: TestDatabase;
  let store: DatabaseSessionStore;
  let guard: SessionGuard<TestUser>;
  let hono: Hono;

  beforeEach(async () => {
    database = await createTestDatabase();
    store = new DatabaseSessionStore();
    guard = new SessionGuard(new StubUserProvider(), store, new Signer(Buffer.alloc(32, 7)), {
      secure: false,
    });

    hono = mount(guard);
  });

  afterEach(() => database.cleanup());

  it("authenticates a request carrying the cookie set at login", async () => {
    const login = await hono.request("/login", { method: "POST" });
    const cookie = cookieFrom(login)!;

    const me = await hono.request("/me", { headers: { Cookie: `session=${cookie}` } });
    await expect(me.json()).resolves.toEqual({ user: alice });
  });

  it("returns null when no cookie is present", async () => {
    const me = await hono.request("/me");
    await expect(me.json()).resolves.toEqual({ user: null });
  });

  it("rejects a tampered cookie", async () => {
    const login = await hono.request("/login", { method: "POST" });
    const cookie = cookieFrom(login)!;
    const tampered = cookie.replace(/.$/, (ch) => (ch === "A" ? "B" : "A"));

    const me = await hono.request("/me", { headers: { Cookie: `session=${tampered}` } });
    await expect(me.json()).resolves.toEqual({ user: null });
  });

  it("rejects an unsigned session id, even a real one", async () => {
    // Signing is what stops an attacker guessing/enumerating raw ids.
    const login = await hono.request("/login", { method: "POST" });
    const { id } = (await login.json()) as { id: string };

    const me = await hono.request("/me", { headers: { Cookie: `session=${id}` } });
    await expect(me.json()).resolves.toEqual({ user: null });
  });

  it("rejects an expired session", async () => {
    const expiring = new SessionGuard<TestUser>(
      new StubUserProvider(),
      store,
      new Signer(Buffer.alloc(32, 7)),
      { secure: false, lifetimeMinutes: -1 },
    );

    const app = mount(expiring);

    const login = await app.request("/login", { method: "POST" });
    const cookie = cookieFrom(login)!;

    const me = await app.request("/me", { headers: { Cookie: `session=${cookie}` } });
    await expect(me.json()).resolves.toEqual({ user: null });
  });

  it("logout() destroys the session so the same cookie stops working", async () => {
    const login = await hono.request("/login", { method: "POST" });
    const cookie = cookieFrom(login)!;

    await hono.request("/logout", { method: "POST", headers: { Cookie: `session=${cookie}` } });

    const me = await hono.request("/me", { headers: { Cookie: `session=${cookie}` } });
    await expect(me.json()).resolves.toEqual({ user: null });
  });

  it("login() regenerates the session id and invalidates the old one", async () => {
    // Session-fixation defense: an attacker who plants a known session id
    // in a victim's browser before login must not still know it after.
    // The single session-specific attack a naive implementation gets
    // wrong, so this must not be "optimised" into reusing the id.
    const first = await hono.request("/login", { method: "POST" });
    const firstCookie = cookieFrom(first)!;
    const firstId = ((await first.json()) as { id: string }).id;

    const second = await hono.request("/login", {
      method: "POST",
      headers: { Cookie: `session=${firstCookie}` },
    });
    const secondId = ((await second.json()) as { id: string }).id;

    expect(secondId).not.toBe(firstId);
    await expect(store.read(firstId)).resolves.toBeNull();
    await expect(store.read(secondId)).resolves.not.toBeNull();
  });

  it("refuses to mint a session for a user the provider can't find", async () => {
    // A deleted account (or a made-up id) must not get a live session
    // cookie whose every request then resolves to null. The route throws
    // LoginUserNotFoundError; Hono surfaces it as a 500, and no session
    // cookie is set.
    const res = await hono.request("/login-ghost", { method: "POST" });

    expect(res.status).toBe(500);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("login() throws LoginUserNotFoundError for an unknown id", async () => {
    const request = Request.create("/login", "POST");
    await expect(guard.login(request, "ghost")).rejects.toBeInstanceOf(LoginUserNotFoundError);
  });

  it("slides the expiry forward on each authenticated request", async () => {
    const login = await hono.request("/login", { method: "POST" });
    const cookie = cookieFrom(login)!;
    const id = ((await login.json()) as { id: string }).id;

    const before = (await store.read(id))!.expiresAt;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await hono.request("/me", { headers: { Cookie: `session=${cookie}` } });

    const after = (await store.read(id))!.expiresAt;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it("sets an httpOnly cookie", async () => {
    const login = await hono.request("/login", { method: "POST" });
    expect(login.headers.get("set-cookie")).toMatch(/HttpOnly/i);
  });

  describe("the cookie itself", () => {
    // These assert on the wire format rather than on behaviour, because
    // every one of these attributes is a security control that fails
    // SILENTLY when wrong: a missing `Secure` leaks the session over
    // plain HTTP, a missing `SameSite` re-opens CSRF, a wrong `Path`
    // makes logout not log out. Nothing else in the suite would notice.

    it("carries every security attribute, not just HttpOnly", async () => {
      const secured = new SessionGuard<TestUser>(
        new StubUserProvider(),
        store,
        new Signer(Buffer.alloc(32, 7)),
        {
          secure: true,
          sameSite: "Strict",
          path: "/app",
          domain: "example.com",
          lifetimeMinutes: 30,
        },
      );

      const login = await mount(secured).request("/login", { method: "POST" });
      const header = login.headers.get("set-cookie")!;

      expect(header).toMatch(/HttpOnly/i);
      expect(header).toMatch(/Secure/i);
      expect(header).toMatch(/SameSite=Strict/i);
      expect(header).toMatch(/Path=\/app/i);
      expect(header).toMatch(/Domain=example\.com/i);
      expect(header).toMatch(/Max-Age=1800/i);
    });

    it("defaults to Secure and SameSite=Lax", async () => {
      const defaults = new SessionGuard<TestUser>(
        new StubUserProvider(),
        store,
        new Signer(Buffer.alloc(32, 7)),
      );

      const login = await mount(defaults).request("/login", { method: "POST" });
      const header = login.headers.get("set-cookie")!;

      expect(header).toMatch(/Secure/i);
      expect(header).toMatch(/SameSite=Lax/i);
      expect(header).toMatch(/Path=\//i);
    });

    it("uses the remember window for Max-Age, not the short lifetime", async () => {
      const remembering = new SessionGuard<TestUser>(
        new StubUserProvider(),
        store,
        new Signer(Buffer.alloc(32, 7)),
        { secure: false, lifetimeMinutes: 120, rememberMinutes: 60 * 24 * 30 },
      );

      const login = await mount(remembering).request("/login-remember", { method: "POST" });
      expect(login.headers.get("set-cookie")).toMatch(/Max-Age=2592000/);
    });

    it("supports the __Host- prefix, which a sibling subdomain cannot overwrite", async () => {
      const hosted = new SessionGuard<TestUser>(
        new StubUserProvider(),
        store,
        new Signer(Buffer.alloc(32, 7)),
        { secure: true, prefix: "host" },
      );
      const app = mount(hosted);

      const login = await app.request("/login", { method: "POST" });
      const header = login.headers.get("set-cookie")!;
      expect(header).toMatch(/^__Host-session=/);
      expect(header).toMatch(/Secure/i);
      expect(header).not.toMatch(/Domain=/i);

      // And it reads back under the prefixed name.
      const cookie = cookieFrom(login, "__Host-session")!;
      const me = await app.request("/me", { headers: { Cookie: `__Host-session=${cookie}` } });
      await expect(me.json()).resolves.toEqual({ user: alice });
    });

    it("re-issues the cookie as the sliding expiry renews", async () => {
      // Without this the browser drops the cookie `lifetimeMinutes`
      // after LOGIN while the server keeps sliding the row forward, an
      // actively-used session that dies mid-use, which is precisely what
      // sliding expiry exists to prevent.
      const login = await hono.request("/login", { method: "POST" });
      const cookie = cookieFrom(login)!;

      const me = await hono.request("/me", { headers: { Cookie: `session=${cookie}` } });

      expect(me.headers.get("set-cookie")).toMatch(/session=/);
      expect(me.headers.get("set-cookie")).toMatch(/Max-Age=7200/);
    });

    it("does not re-issue a remembered session's far-future cookie", async () => {
      const remembering = new SessionGuard<TestUser>(
        new StubUserProvider(),
        store,
        new Signer(Buffer.alloc(32, 7)),
        { secure: false, lifetimeMinutes: 120, rememberMinutes: 60 * 24 * 30 },
      );
      const app = mount(remembering);

      const login = await app.request("/login-remember", { method: "POST" });
      const cookie = cookieFrom(login)!;

      const me = await app.request("/me", { headers: { Cookie: `session=${cookie}` } });
      expect(me.headers.get("set-cookie")).toBeNull();
    });

    it("can opt out of the sliding cookie for an absolute lifetime", async () => {
      const absolute = new SessionGuard<TestUser>(
        new StubUserProvider(),
        store,
        new Signer(Buffer.alloc(32, 7)),
        { secure: false, slidingCookie: false },
      );
      const app = mount(absolute);

      const login = await app.request("/login", { method: "POST" });
      const cookie = cookieFrom(login)!;

      const me = await app.request("/me", { headers: { Cookie: `session=${cookie}` } });
      expect(me.headers.get("set-cookie")).toBeNull();
    });

    it("logout expires the cookie with a matching Path and Domain", async () => {
      // A deletion whose Path/Domain don't match the original is a
      // DIFFERENT cookie as far as the browser is concerned, so the real
      // one survives and the user stays logged in.
      const scoped = new SessionGuard<TestUser>(
        new StubUserProvider(),
        store,
        new Signer(Buffer.alloc(32, 7)),
        { secure: false, path: "/app", domain: "example.com" },
      );
      const app = mount(scoped);

      const login = await app.request("/login", { method: "POST" });
      const cookie = cookieFrom(login)!;

      const logout = await app.request("/logout", {
        method: "POST",
        headers: { Cookie: `session=${cookie}` },
      });
      const header = logout.headers.get("set-cookie")!;

      expect(header).toMatch(/session=;/);
      expect(header).toMatch(/Max-Age=0/);
      expect(header).toMatch(/Path=\/app/i);
      expect(header).toMatch(/Domain=example\.com/i);
    });
  });

  describe("remember me", () => {
    it("gives a remembered session a far-future expiry, not the normal lifetime", async () => {
      const remembering = new SessionGuard<TestUser>(
        new StubUserProvider(),
        store,
        new Signer(Buffer.alloc(32, 7)),
        { secure: false, lifetimeMinutes: 120, rememberMinutes: 60 * 24 * 30 },
      );

      const app = mount(remembering);

      const login = await app.request("/login-remember", { method: "POST" });
      const id = ((await login.json()) as { id: string }).id;

      const expiresAt = (await store.read(id))!.expiresAt;
      // Far beyond the normal 120-minute lifetime.
      const daysOut = (new Date(expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(daysOut).toBeGreaterThan(20);
    });

    it("a remembered session's long expiry is not shrunk back on the next request", async () => {
      const remembering = new SessionGuard<TestUser>(
        new StubUserProvider(),
        store,
        new Signer(Buffer.alloc(32, 7)),
        { secure: false, lifetimeMinutes: 120, rememberMinutes: 60 * 24 * 30 },
      );

      const app = mount(remembering);

      const login = await app.request("/login-remember", { method: "POST" });
      const cookie = cookieFrom(login)!;
      const id = ((await login.json()) as { id: string }).id;
      const before = (await store.read(id))!.expiresAt;

      await app.request("/me", { headers: { Cookie: `session=${cookie}` } });

      const after = (await store.read(id))!.expiresAt;
      // Still far in the future. The sliding renewal must not clamp it to
      // the short lifetime.
      expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
      const daysOut = (new Date(after).getTime() - Date.now()) / 86_400_000;
      expect(daysOut).toBeGreaterThan(20);
    });
  });

  describe("logoutOtherDevices", () => {
    async function post(path: string, cookie: string, body: unknown): Promise<Response> {
      return hono.request(path, {
        method: "POST",
        headers: { Cookie: `session=${cookie}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("revokes other sessions but keeps the current one when the password checks out", async () => {
      const current = await hono.request("/login", { method: "POST" });
      const currentCookie = cookieFrom(current)!;
      const other = await hono.request("/login", { method: "POST" });
      const otherCookie = cookieFrom(other)!;

      const result = await post("/logout-others", currentCookie, { password: "correct-password" });
      await expect(result.json()).resolves.toEqual({ ok: true });

      const me = await hono.request("/me", { headers: { Cookie: `session=${currentCookie}` } });
      await expect(me.json()).resolves.toEqual({ user: alice });

      const gone = await hono.request("/me", { headers: { Cookie: `session=${otherCookie}` } });
      await expect(gone.json()).resolves.toEqual({ user: null });
    });

    it("returns false and revokes nothing when the password is wrong", async () => {
      const current = await hono.request("/login", { method: "POST" });
      const currentCookie = cookieFrom(current)!;
      const other = await hono.request("/login", { method: "POST" });
      const otherCookie = cookieFrom(other)!;

      const result = await post("/logout-others", currentCookie, { password: "wrong-password" });
      await expect(result.json()).resolves.toEqual({ ok: false });

      const stillThere = await hono.request("/me", {
        headers: { Cookie: `session=${otherCookie}` },
      });
      await expect(stillThere.json()).resolves.toEqual({ user: alice });
    });
  });

  it("logoutEverywhere() invalidates every session for the user", async () => {
    const first = await hono.request("/login", { method: "POST" });
    const firstCookie = cookieFrom(first)!;
    // A second, independent browser, no cookie sent, so no regeneration.
    const second = await hono.request("/login", { method: "POST" });
    const secondCookie = cookieFrom(second)!;

    await guard.logoutEverywhere(alice.id);

    for (const cookie of [firstCookie, secondCookie]) {
      const me = await hono.request("/me", { headers: { Cookie: `session=${cookie}` } });
      await expect(me.json()).resolves.toEqual({ user: null });
    }
  });

  describe("sessionId()", () => {
    it("returns the id established at login", async () => {
      const login = await hono.request("/login", { method: "POST" });
      const { id } = (await login.json()) as { id: string };
      const cookie = cookieFrom(login)!;

      const result = await hono.request("/session-id", {
        headers: { Cookie: `session=${cookie}` },
      });
      await expect(result.json()).resolves.toEqual({ sessionId: id });
    });

    it("returns null without a cookie", async () => {
      const result = await hono.request("/session-id");
      await expect(result.json()).resolves.toEqual({ sessionId: null });
    });

    it("returns null for a tampered cookie rather than the raw payload", async () => {
      // The signature is the whole guarantee: without this check a caller
      // binding anything to the returned id would be binding to a value
      // the client chose.
      const login = await hono.request("/login", { method: "POST" });
      const cookie = cookieFrom(login)!;
      const tampered = cookie.replace(/.$/, (ch) => (ch === "A" ? "B" : "A"));

      const result = await hono.request("/session-id", {
        headers: { Cookie: `session=${tampered}` },
      });
      await expect(result.json()).resolves.toEqual({ sessionId: null });
    });

    it("does not renew the session it reads", async () => {
      // Reading an identifier is not activity. If this slid the window,
      // an unrelated capability check would keep an abandoned session
      // alive indefinitely.
      const login = await hono.request("/login", { method: "POST" });
      const { id } = (await login.json()) as { id: string };
      const before = (await store.read(id))!.expiresAt;

      await hono.request("/session-id", {
        headers: { Cookie: `session=${cookieFrom(login)!}` },
      });

      expect((await store.read(id))!.expiresAt).toBe(before);
    });
  });

  describe("sessionLifetimeRemaining()", () => {
    it("reports roughly the configured lifetime for an ordinary session", async () => {
      const login = await hono.request("/login", { method: "POST" });

      const result = await hono.request("/session-remaining", {
        headers: { Cookie: `session=${cookieFrom(login)!}` },
      });
      const { remaining } = (await result.json()) as { remaining: number };

      // 120 minutes, give or take the milliseconds the request took.
      expect(remaining).toBeGreaterThan(119 * 60_000);
      expect(remaining).toBeLessThanOrEqual(120 * 60_000);
    });

    it("distinguishes a remembered session from an ordinary one", async () => {
      // The reason this method exists. Remember-me here is not a flag but
      // a longer expiry, so this is the only evidence that a session was
      // remembered, which is what lets a caller replacing the session
      // restore it in kind.
      const remembering = new SessionGuard<TestUser>(
        new StubUserProvider(),
        store,
        new Signer(Buffer.alloc(32, 7)),
        { secure: false, lifetimeMinutes: 120, rememberMinutes: 60 * 24 * 30 },
      );
      const rememberingApp = mount(remembering);

      const login = await rememberingApp.request("/login-remember", { method: "POST" });

      const result = await rememberingApp.request("/session-remaining", {
        headers: { Cookie: `session=${cookieFrom(login)!}` },
      });
      const { remaining } = (await result.json()) as { remaining: number };

      // 30 days, comfortably past the 120-minute ordinary lifetime, which
      // is the threshold a caller compares against.
      expect(remaining).toBeGreaterThan(120 * 60_000);
      expect(remaining).toBeGreaterThan(29 * 24 * 60 * 60_000);
    });

    it("returns null without a cookie", async () => {
      const result = await hono.request("/session-remaining");
      await expect(result.json()).resolves.toEqual({ remaining: null });
    });

    it("returns null once the session is gone server-side", async () => {
      // Unlike `sessionId()`, this one answers liveness: it reads the
      // store, so a revoked session reports null rather than a stale
      // lifetime.
      const login = await hono.request("/login", { method: "POST" });
      const { id } = (await login.json()) as { id: string };
      await store.destroy(id);

      const result = await hono.request("/session-remaining", {
        headers: { Cookie: `session=${cookieFrom(login)!}` },
      });
      await expect(result.json()).resolves.toEqual({ remaining: null });
    });

    it("does not renew the session it reads", async () => {
      const login = await hono.request("/login", { method: "POST" });
      const { id } = (await login.json()) as { id: string };
      const before = (await store.read(id))!.expiresAt;

      await hono.request("/session-remaining", {
        headers: { Cookie: `session=${cookieFrom(login)!}` },
      });

      expect((await store.read(id))!.expiresAt).toBe(before);
    });
  });
});
