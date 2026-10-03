import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTH_TOKEN } from "@mahiframework/core";
import { HttpError } from "@mahiframework/http";
import type { Request } from "@mahiframework/http";
import { MfaManager } from "../src/mfa-manager.js";
import { MFA_TOKEN } from "../src/tokens.js";
import { runWithMfa } from "../src/mfa-context.js";
import { mfaVerified, requireMfa, currentMfaBinding } from "../src/require-mfa.js";
import {
  MfaEnrollmentRequiredError,
  MfaLockedError,
  MfaRequiredError,
  MissingMfaContextError,
} from "../src/errors.js";
import type { MfaDriver } from "../src/mfa-driver.js";
import { createTestDatabase, makeIntent, type TestDatabase } from "./__fixtures__/test-database.js";

/** Enrolled for whoever asks, so these tests isolate the guard logic. */
function enrolledDriver(name: string): MfaDriver {
  return {
    name,
    enrolled: async () => true,
    challenge: async () => ({ status: "ready" }),
    verify: async () => ({ status: "verified" }),
  };
}

function unenrolledDriver(name: string): MfaDriver {
  return { ...enrolledDriver(name), enrolled: async () => false };
}

describe("requireMfa", () => {
  let database: TestDatabase;
  const request = {} as Request;

  /** Bind the container for a given user and driver enrollment state. */
  function wire(options: { enrolled?: boolean; whenUnenrolled?: "deny" | "allow" | "challenge" }) {
    const manager = new MfaManager(database.app, {
      drivers: ["totp"],
      ...(options.whenUnenrolled === undefined ? {} : { whenUnenrolled: options.whenUnenrolled }),
    });

    manager.extend("totp", () =>
      options.enrolled === false ? unenrolledDriver("totp") : enrolledDriver("totp"),
    );

    database.app.instance(MFA_TOKEN, manager);

    return manager;
  }

  function authenticateAs(user: unknown) {
    database.app.instance(AUTH_TOKEN, {
      userOrNull: () => user,
      userProvider: () => ({ retrieveById: async (id: string) => ({ id }) }),
      guard: () => ({}),
      getDefaultDriver: () => "web",
    });
  }

  /** Run inside an MFA scope, as the provider's pipe would. */
  function inScope<T>(fn: () => T, binding: string | null = null): T {
    return runWithMfa({ binding, request }, fn);
  }

  beforeEach(async () => {
    database = await createTestDatabase();
    authenticateAs({ id: "user-1" });
    wire({});
  });

  afterEach(() => database.cleanup());

  describe("authentication", () => {
    it("401s a guest", async () => {
      // 401, not 403: authenticating would fix this.
      authenticateAs(null);

      await expect(inScope(() => requireMfa())).rejects.toThrow(HttpError);
      await expect(inScope(() => requireMfa())).rejects.toMatchObject({ status: 401 });
    });

    it("401s a user with no id", async () => {
      authenticateAs({ email: "no-id@x.test" });

      await expect(inScope(() => requireMfa())).rejects.toMatchObject({ status: 401 });
    });
  });

  describe("with a live verified intent", () => {
    it("passes a generic check", async () => {
      await makeIntent({ userId: "user-1", status: "verified" });

      await expect(inScope(() => requireMfa())).resolves.toBeUndefined();
    });

    it("passes a matching named check", async () => {
      await makeIntent({ userId: "user-1", status: "verified", purpose: "change_password" });

      await expect(inScope(() => requireMfa("change_password"))).resolves.toBeUndefined();
    });

    it("passes a generic check off a named intent (specific rolls up)", async () => {
      await makeIntent({ userId: "user-1", status: "verified", purpose: "change_password" });

      await expect(inScope(() => requireMfa())).resolves.toBeUndefined();
    });

    it("REFUSES a named check off a generic intent (generic does not roll down)", async () => {
      await makeIntent({ userId: "user-1", status: "verified", purpose: null });

      await expect(inScope(() => requireMfa("billing.payout"))).rejects.toThrow(MfaRequiredError);
    });

    it("carries the purpose and available drivers on the error", async () => {
      // The client has to render "verify again FOR THIS ACTION" and a
      // method picker; a message string cannot drive either.
      await makeIntent({ userId: "user-1", status: "verified", purpose: null });

      await expect(inScope(() => requireMfa("billing.payout"))).rejects.toMatchObject({
        status: 403,
        details: { code: "mfa_required", purpose: "billing.payout", available: ["totp"] },
      });
    });
  });

  describe("without a verified intent", () => {
    it("throws MfaRequiredError listing what the user can use", async () => {
      await expect(inScope(() => requireMfa())).rejects.toMatchObject({
        status: 403,
        details: { code: "mfa_required", purpose: null, available: ["totp"] },
      });
    });

    it("reports a locked intent distinctly", async () => {
      // So the client says "start again" rather than re-prompting into
      // a wall.
      await makeIntent({ userId: "user-1", status: "locked" });

      await expect(inScope(() => requireMfa())).rejects.toThrow(MfaLockedError);
      await expect(inScope(() => requireMfa())).rejects.toMatchObject({
        details: { code: "mfa_locked" },
      });
    });
  });

  describe("whenUnenrolled", () => {
    it("denies by default", async () => {
      wire({ enrolled: false });

      await expect(inScope(() => requireMfa())).rejects.toMatchObject({
        status: 403,
        // Empty `available`: correctly "you cannot proceed", without
        // advertising an enrollment path this policy does not offer.
        details: { code: "mfa_required", available: [] },
      });
    });

    it("allows when configured to", async () => {
      wire({ enrolled: false, whenUnenrolled: "allow" });

      await expect(inScope(() => requireMfa())).resolves.toBeUndefined();
    });

    it("asks for enrollment when configured to", async () => {
      wire({ enrolled: false, whenUnenrolled: "challenge" });

      await expect(inScope(() => requireMfa())).rejects.toThrow(MfaEnrollmentRequiredError);
      await expect(inScope(() => requireMfa())).rejects.toMatchObject({
        details: { code: "mfa_enrollment_required", enrollable: ["totp"] },
      });
    });

    it("is overridable per call, over the config default", async () => {
      wire({ enrolled: false, whenUnenrolled: "deny" });

      await expect(
        inScope(() => requireMfa(null, { whenUnenrolled: "allow" })),
      ).resolves.toBeUndefined();
    });

    it("does not apply to an ENROLLED user with no verification", async () => {
      // `allow` must not become a blanket bypass for everyone.
      wire({ enrolled: true, whenUnenrolled: "allow" });

      await expect(inScope(() => requireMfa())).rejects.toThrow(MfaRequiredError);
    });
  });

  describe("session binding", () => {
    it("passes when the intent is bound to this session", async () => {
      await makeIntent({ userId: "user-1", status: "verified", binding: "session-a" });

      await expect(inScope(() => requireMfa(), "session-a")).resolves.toBeUndefined();
    });

    it("REFUSES another session's verification", async () => {
      await makeIntent({ userId: "user-1", status: "verified", binding: "session-a" });

      await expect(inScope(() => requireMfa(), "session-b")).rejects.toThrow(MfaRequiredError);
    });
  });

  describe("outside a request scope", () => {
    it("THROWS rather than passing or denying", async () => {
      // Neither is defensible for "the wiring is wrong": passing is a
      // silent bypass, denying is a 403 nobody can act on.
      await makeIntent({ userId: "user-1", status: "verified" });

      await expect(requireMfa()).rejects.toThrow(MissingMfaContextError);
    });

    it("names both causes in the message", async () => {
      await expect(requireMfa()).rejects.toThrow(/MfaServiceProvider is not registered/);
      await expect(requireMfa()).rejects.toThrow(/outside an HTTP request/);
    });

    it("works with an explicit request, for a job or a command", async () => {
      await makeIntent({ userId: "user-1", status: "verified" });

      await expect(requireMfa(null, { request })).resolves.toBeUndefined();
    });
  });

  describe("mfaVerified", () => {
    it("is true where requireMfa passes", async () => {
      await makeIntent({ userId: "user-1", status: "verified" });

      expect(await inScope(() => mfaVerified())).toBe(true);
    });

    it("is false instead of throwing where requireMfa fails", async () => {
      expect(await inScope(() => mfaVerified())).toBe(false);
    });

    it("follows the same asymmetric purpose rule", async () => {
      await makeIntent({ userId: "user-1", status: "verified", purpose: "change_password" });

      expect(await inScope(() => mfaVerified())).toBe(true);
      expect(await inScope(() => mfaVerified("change_password"))).toBe(true);
      expect(await inScope(() => mfaVerified("delete_account"))).toBe(false);
    });

    it("does NOT apply whenUnenrolled: it answers the question asked", async () => {
      // `allow` is a policy about whether to BLOCK, not a claim that the
      // user verified. A UI reading this must not show a padlock.
      wire({ enrolled: false, whenUnenrolled: "allow" });

      expect(await inScope(() => mfaVerified())).toBe(false);
      await expect(inScope(() => requireMfa())).resolves.toBeUndefined();
    });
  });

  describe("currentMfaBinding", () => {
    it("reports the scope's binding", () => {
      expect(inScope(() => currentMfaBinding(), "session-a")).toBe("session-a");
    });

    it("is null outside a scope, rather than throwing", () => {
      // Diagnostic helper, not a guard, so it degrades rather than
      // failing.
      expect(currentMfaBinding()).toBeNull();
    });
  });
});
