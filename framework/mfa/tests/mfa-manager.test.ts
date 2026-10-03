import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTH_TOKEN } from "@mahiframework/core";
import { DateTime } from "@mahiframework/datetime";
import { MfaManager } from "../src/mfa-manager.js";
import { MfaIntent } from "../src/models/mfa-intent.js";
import { UnknownMfaDriverError } from "../src/errors.js";
import type { MfaDriver, VerifyResult } from "../src/mfa-driver.js";
import { createTestDatabase, makeIntent, type TestDatabase } from "./__fixtures__/test-database.js";

/** A driver whose behaviour each test dictates. */
class StubDriver implements MfaDriver {
  enrolledUsers = new Set<string>(["user-1"]);
  accept = "good";
  challenges = 0;

  constructor(readonly name: string) {}

  async enrolled(userId: string): Promise<boolean> {
    return this.enrolledUsers.has(userId);
  }

  async challenge(): Promise<{ status: "ready" }> {
    this.challenges += 1;

    return { status: "ready" };
  }

  async verify(context: { code: string }): Promise<VerifyResult> {
    return context.code === this.accept ? { status: "verified" } : { status: "invalid-code" };
  }
}

describe("MfaManager", () => {
  let database: TestDatabase;
  let manager: MfaManager;
  let totp: StubDriver;

  function build(config: Partial<Parameters<typeof makeManager>[0]> = {}) {
    return makeManager({ drivers: ["totp", "email"], ...config });
  }

  function makeManager(config: {
    drivers: string[];
    maxAttempts?: number;
    bindToSession?: boolean;
    whenUnenrolled?: "deny" | "allow" | "challenge";
    verificationExpiresInMinutes?: number;
    intentExpiresInMinutes?: number;
  }) {
    const instance = new MfaManager(database.app, config);
    totp = new StubDriver("totp");
    instance.extend("totp", () => totp);
    instance.extend("email", () => new StubDriver("email"));

    return instance;
  }

  beforeEach(async () => {
    database = await createTestDatabase();
    // The manager reaches auth for the user provider and the guard probe.
    database.app.instance(AUTH_TOKEN, {
      userProvider: () => ({ retrieveById: async (id: string) => ({ id, email: `${id}@x.test` }) }),
      guard: () => ({}),
      getDefaultDriver: () => "web",
    });
    manager = build();
  });

  afterEach(() => database.cleanup());

  describe("driver resolution", () => {
    it("resolves a configured driver", () => {
      expect(manager.use("totp").name).toBe("totp");
    });

    it("refuses a driver the app has not listed, even if registered", () => {
      // Registration and availability are separate: the provider
      // registers all built-ins, `config.drivers` is what exposes them.
      const narrow = makeManager({ drivers: ["totp"] });

      expect(() => narrow.use("email")).toThrow(UnknownMfaDriverError);
    });

    it("reports configured drivers in config order", () => {
      expect(manager.configuredDrivers()).toEqual(["totp", "email"]);
    });

    it("throws a useful error when nothing is configured", () => {
      const empty = new MfaManager(database.app, { drivers: [] });

      expect(() => empty.getDefaultDriver()).toThrow(/No MFA drivers are configured/);
    });
  });

  describe("available", () => {
    it("lists only the drivers the user is enrolled in, in config order", async () => {
      expect(await manager.available("user-1")).toEqual(["totp", "email"]);
      expect(await manager.available("stranger")).toEqual([]);
    });

    it("survives a driver whose enrollment check throws", async () => {
      // One broken factor must not make the others unreachable, which is
      // exactly the situation a user needs their other factors in.
      manager.extend("totp", () => ({
        name: "totp",
        enrolled: () => Promise.reject(new Error("boom")),
        challenge: () => Promise.resolve({ status: "ready" as const }),
        verify: () => Promise.resolve({ status: "invalid-code" as const }),
      }));

      expect(await manager.available("user-1")).toEqual(["email"]);
    });
  });

  describe("createIntent", () => {
    it("persists a pending intent with both deadlines set appropriately", async () => {
      const intent = await manager.createIntent({ userId: "user-1" });

      expect(intent.status).toBe("pending");
      expect(intent.purpose).toBeNull();
      expect(intent.intent_expires_at.isFuture()).toBe(true);
      // The sudo window opens at verification, not creation.
      expect(intent.verification_expires_at).toBeNull();
      expect(intent.verified_at).toBeNull();
    });

    it("REUSES a live pending intent rather than minting a second", async () => {
      // A user who reloads the verify page must land back on the attempt
      // they started, or the attempt counter resets on every reload and
      // maxAttempts enforces nothing.
      const first = await manager.createIntent({ userId: "user-1", purpose: "p" });
      const second = await manager.createIntent({ userId: "user-1", purpose: "p" });

      expect(second.id).toBe(first.id);
      expect(await MfaIntent.query().count()).toBe(1);
    });

    it("does not reuse across a different purpose", async () => {
      const generic = await manager.createIntent({ userId: "user-1" });
      const named = await manager.createIntent({ userId: "user-1", purpose: "billing" });

      // `purpose IS NULL` vs `purpose = 'billing'`: a `= null` comparison
      // would match nothing and silently mint a new intent every time.
      expect(named.id).not.toBe(generic.id);
    });

    it("does not reuse across a different binding", async () => {
      const a = await manager.createIntent({ userId: "user-1", binding: "session-a" });
      const b = await manager.createIntent({ userId: "user-1", binding: "session-b" });

      expect(b.id).not.toBe(a.id);
    });

    it("does not reuse an expired intent", async () => {
      const stale = await makeIntent({ userId: "user-1", expiresInMinutes: -1 });
      const fresh = await manager.createIntent({ userId: "user-1" });

      expect(fresh.id).not.toBe(stale.id);
    });

    it("does not reuse a locked intent", async () => {
      const locked = await makeIntent({ userId: "user-1", status: "locked" });
      const fresh = await manager.createIntent({ userId: "user-1" });

      expect(fresh.id).not.toBe(locked.id);
    });
  });

  describe("challenge", () => {
    it("records the driver on the intent before issuing", async () => {
      const intent = await manager.createIntent({ userId: "user-1" });
      await manager.challenge(intent, "totp");

      expect((await MfaIntent.find(intent.id))!.driver).toBe("totp");
      expect(totp.challenges).toBe(1);
    });

    it("is unavailable when the user has vanished", async () => {
      database.app.instance(AUTH_TOKEN, {
        userProvider: () => ({ retrieveById: async () => null }),
        guard: () => ({}),
        getDefaultDriver: () => "web",
      });

      const intent = await makeIntent({ userId: "ghost" });

      expect(await manager.challenge(intent, "totp")).toMatchObject({ status: "unavailable" });
    });
  });

  describe("verify", () => {
    async function pending() {
      const intent = await manager.createIntent({ userId: "user-1" });
      await manager.challenge(intent, "totp");

      return intent;
    }

    it("marks the intent verified and opens the sudo window", async () => {
      const intent = await pending();

      expect(await manager.verify(intent, "good")).toEqual({ status: "verified" });

      const stored = (await MfaIntent.find(intent.id))!;
      expect(stored.status).toBe("verified");
      expect(stored.verified_at).not.toBeNull();
      expect(stored.verification_expires_at!.isFuture()).toBe(true);
    });

    it("counts a wrong code", async () => {
      const intent = await pending();
      await manager.verify(intent, "bad");

      expect((await MfaIntent.find(intent.id))!.attempts).toBe(1);
    });

    it("LOCKS the intent at maxAttempts", async () => {
      const strict = makeManager({ drivers: ["totp"], maxAttempts: 3 });
      const intent = await strict.createIntent({ userId: "user-1" });
      await strict.challenge(intent, "totp");

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await strict.verify(intent, "bad");
      }

      expect((await MfaIntent.find(intent.id))!.status).toBe("locked");
    });

    it("a locked intent cannot be rescued by the right code", async () => {
      const strict = makeManager({ drivers: ["totp"], maxAttempts: 1 });
      const intent = await strict.createIntent({ userId: "user-1" });
      await strict.challenge(intent, "totp");
      await strict.verify(intent, "bad");

      expect(await strict.verify(intent, "good")).toMatchObject({ status: "unavailable" });
      expect((await MfaIntent.find(intent.id))!.status).toBe("locked");
    });

    it("does not count a non-guess against the limit", async () => {
      // An expired or missing challenge is not a wrong guess, and
      // counting it would let a slow user lock themselves out.
      manager.extend("totp", () => ({
        name: "totp",
        enrolled: async () => true,
        challenge: async () => ({ status: "ready" as const }),
        verify: async () => ({ status: "expired" as const }),
      }));

      const intent = await manager.createIntent({ userId: "user-1" });
      await manager.challenge(intent, "totp");
      await manager.verify(intent, "whatever");

      expect((await MfaIntent.find(intent.id))!.attempts).toBe(0);
    });

    it("refuses an intent past its deadline", async () => {
      const intent = await makeIntent({ userId: "user-1", driver: "totp", expiresInMinutes: -1 });

      expect(await manager.verify(intent, "good")).toEqual({ status: "expired" });
    });

    it("reports no-challenge when no driver was chosen", async () => {
      const intent = await manager.createIntent({ userId: "user-1" });

      expect(await manager.verify(intent, "good")).toEqual({ status: "no-challenge" });
    });

    it("is idempotent for an already-verified intent", async () => {
      // A double-clicked submit is not an error.
      const intent = await makeIntent({ userId: "user-1", driver: "totp", status: "verified" });

      expect(await manager.verify(intent, "good")).toEqual({ status: "verified" });
    });
  });

  describe("hasVerified: the purpose matching rule", () => {
    it("a generic requirement is satisfied by a generic intent", async () => {
      await makeIntent({ userId: "user-1", status: "verified", purpose: null });

      expect(await manager.hasVerified("user-1", null, null)).toBe(true);
    });

    it("a named requirement is satisfied by its exact match", async () => {
      await makeIntent({ userId: "user-1", status: "verified", purpose: "change_password" });

      expect(await manager.hasVerified("user-1", "change_password", null)).toBe(true);
    });

    it("SPECIFIC ROLLS UP: a named intent satisfies a generic requirement", async () => {
      // The user proved a factor more recently and more deliberately
      // than a bare check asks for, so re-prompting is friction with no
      // security gain.
      await makeIntent({ userId: "user-1", status: "verified", purpose: "change_password" });

      expect(await manager.hasVerified("user-1", null, null)).toBe(true);
    });

    it("GENERIC DOES NOT ROLL DOWN: a generic intent fails a named requirement", async () => {
      // The case `requireMfa("billing.payout")` exists to prevent: a
      // routine step-up at login must not silently authorize a payout.
      await makeIntent({ userId: "user-1", status: "verified", purpose: null });

      expect(await manager.hasVerified("user-1", "billing.payout", null)).toBe(false);
    });

    it("one named purpose does not satisfy another", async () => {
      await makeIntent({ userId: "user-1", status: "verified", purpose: "delete_account" });

      expect(await manager.hasVerified("user-1", "change_password", null)).toBe(false);
    });

    it("an unverified intent satisfies nothing", async () => {
      await makeIntent({ userId: "user-1", status: "pending", purpose: null });

      expect(await manager.hasVerified("user-1", null, null)).toBe(false);
    });

    it("a locked intent satisfies nothing", async () => {
      await makeIntent({ userId: "user-1", status: "locked", purpose: null });

      expect(await manager.hasVerified("user-1", null, null)).toBe(false);
    });

    it("another user's verification satisfies nothing", async () => {
      await makeIntent({ userId: "someone-else", status: "verified" });

      expect(await manager.hasVerified("user-1", null, null)).toBe(false);
    });

    it("an elapsed sudo window satisfies nothing", async () => {
      await makeIntent({ userId: "user-1", status: "verified", verifiedForMinutes: -1 });

      expect(await manager.hasVerified("user-1", null, null)).toBe(false);
    });
  });

  describe("hasVerified: session binding", () => {
    it("honours an intent bound to the same session", async () => {
      await makeIntent({ userId: "user-1", status: "verified", binding: "session-a" });

      expect(await manager.hasVerified("user-1", null, "session-a")).toBe(true);
    });

    it("REFUSES an intent bound to a different session", async () => {
      // Stops a second concurrent session riding a verification it never
      // performed.
      await makeIntent({ userId: "user-1", status: "verified", binding: "session-a" });

      expect(await manager.hasVerified("user-1", null, "session-b")).toBe(false);
    });

    it("does not enforce binding for a request that has none", async () => {
      // A guard exposing no per-request identifier is a supported
      // configuration, not an error; enabling binding must not break it.
      await makeIntent({ userId: "user-1", status: "verified", binding: "session-a" });

      expect(await manager.hasVerified("user-1", null, null)).toBe(true);
    });

    it("ignores binding entirely when it is turned off", async () => {
      const unbound = makeManager({ drivers: ["totp"], bindToSession: false });
      await makeIntent({ userId: "user-1", status: "verified", binding: "session-a" });

      expect(await unbound.hasVerified("user-1", null, "session-b")).toBe(true);
    });
  });

  describe("bindingFor", () => {
    const request = {} as never;

    it("reads a session guard's sessionId()", async () => {
      database.app.instance(AUTH_TOKEN, {
        userProvider: () => ({ retrieveById: async () => ({ id: "user-1" }) }),
        guard: () => ({ sessionId: () => "session-abc" }),
        getDefaultDriver: () => "web",
      });

      expect(build().bindingFor(request)).toBe("session-abc");
    });

    it("falls back to a token guard's currentTokenId()", async () => {
      // Capability-probed rather than looked up by name, because guards
      // are named by the app.
      database.app.instance(AUTH_TOKEN, {
        userProvider: () => ({ retrieveById: async () => ({ id: "user-1" }) }),
        guard: () => ({ currentTokenId: () => "token-xyz" }),
        getDefaultDriver: () => "api",
      });

      expect(build().bindingFor(request)).toBe("token-xyz");
    });

    it("is null for a guard that exposes neither", () => {
      expect(manager.bindingFor(request)).toBeNull();
    });

    it("is null when binding is disabled, even on a session guard", () => {
      database.app.instance(AUTH_TOKEN, {
        userProvider: () => ({ retrieveById: async () => ({ id: "user-1" }) }),
        guard: () => ({ sessionId: () => "session-abc" }),
        getDefaultDriver: () => "web",
      });

      expect(
        makeManager({ drivers: ["totp"], bindToSession: false }).bindingFor(request),
      ).toBeNull();
    });

    it("is null when the guard cannot be resolved at all", () => {
      database.app.instance(AUTH_TOKEN, {
        userProvider: () => ({ retrieveById: async () => ({ id: "user-1" }) }),
        guard: () => {
          throw new Error("no such guard");
        },
        getDefaultDriver: () => "web",
      });

      expect(build().bindingFor(request)).toBeNull();
    });
  });

  describe("gc", () => {
    it("deletes an unverified intent past its deadline", async () => {
      await makeIntent({ expiresInMinutes: -1 });

      expect(await manager.gc()).toBe(1);
      expect(await MfaIntent.query().count()).toBe(0);
    });

    it("deletes a verified intent past its sudo window", async () => {
      await makeIntent({ status: "verified", verifiedForMinutes: -1 });

      expect(await manager.gc()).toBe(1);
    });

    it("keeps a live pending intent", async () => {
      await makeIntent();

      expect(await manager.gc()).toBe(0);
      expect(await MfaIntent.query().count()).toBe(1);
    });

    it("keeps a verified intent whose sudo window is still open, even past the intent deadline", async () => {
      // `intent_expires_at` governs the CHALLENGE, not the proof. A user
      // who verified at minute 9 of a 10-minute window must not lose
      // their sudo window at minute 11.
      await MfaIntent.create({
        id: "verified-late",
        user_id: "user-1",
        binding: null,
        purpose: null,
        status: "verified",
        driver: "totp",
        attempts: 0,
        verified_at: DateTime.now(),
        verification_expires_at: DateTime.now().addMinutes(15),
        intent_expires_at: DateTime.now().subMinutes(1),
        created_at: DateTime.now(),
      });

      expect(await manager.gc()).toBe(0);
      expect(await MfaIntent.query().count()).toBe(1);
    });
  });
});
