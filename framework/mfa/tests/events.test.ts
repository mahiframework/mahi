import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTH_TOKEN, Application, EVENTS_TOKEN, clearCurrentApp } from "@mahiframework/core";
import { AbstractEvent, EventDispatcher } from "@mahiframework/events";
import { DateTime } from "@mahiframework/datetime";
import { MfaManager } from "../src/mfa-manager.js";
import { TotpDriver } from "../src/drivers/totp-driver.js";
import { EmailDriver } from "../src/drivers/email-driver.js";
import { RecoveryDriver } from "../src/drivers/recovery-driver.js";
import { MfaRecoveryCode } from "../src/models/mfa-recovery-code.js";
import { generateCode } from "../src/totp/totp.js";
import type { MfaDriver, VerifyResult } from "../src/mfa-driver.js";
import {
  ChallengeIssued,
  ChallengeThrottled,
  IntentLocked,
  MethodConfirmed,
  MethodEnrolled,
  MfaEvent,
  RecoveryCodeUsed,
  RecoveryCodesGenerated,
  VerificationFailed,
  Verified,
  fireMfaEvent,
} from "../src/events/index.js";
import {
  createTestDatabase,
  makeIntent,
  testEncrypter,
  testHasher,
  testSigner,
  type TestDatabase,
} from "./__fixtures__/test-database.js";

/** A driver whose verify outcome each test dictates. */
class StubDriver implements MfaDriver {
  readonly name = "stub";
  result: VerifyResult = { status: "verified" };

  async enrolled(): Promise<boolean> {
    return true;
  }

  async challenge(): Promise<{ status: "ready" }> {
    return { status: "ready" };
  }

  async verify(): Promise<VerifyResult> {
    return this.result;
  }
}

describe("mfa events", () => {
  let database: TestDatabase;
  let dispatcher: EventDispatcher;
  let seen: MfaEvent[];

  /**
   * Bind a real dispatcher onto the fixture's app and collect everything.
   *
   * Collecting through the abstract `MfaEvent` base rather than per class
   * is itself part of what is under test: it is the registration an audit
   * log should use, and it only works because `listen()` accepts an
   * abstract matcher.
   */
  function listen(): void {
    dispatcher = new EventDispatcher(database.app);
    database.app.instance(EVENTS_TOKEN, dispatcher);
    seen = [];
    dispatcher.listen(MfaEvent, (event) => void seen.push(event));
  }

  function only<T extends MfaEvent>(kind: new (...args: never[]) => T): T[] {
    return seen.filter((event): event is T => event instanceof kind);
  }

  beforeEach(async () => {
    database = await createTestDatabase();
    listen();
  });

  afterEach(() => database.cleanup());

  describe("fireMfaEvent", () => {
    it("is a no-op when no dispatcher is bound", async () => {
      // An app with no EventsServiceProvider must still get working MFA,
      // rather than a BindingNotFoundError mid-enrollment.
      const bare = new Application();

      await expect(
        fireMfaEvent(new MethodEnrolled("user-1", "totp", "m1", null), bare),
      ).resolves.toBeUndefined();
    });

    it("is a no-op when there is no current application at all", async () => {
      // A driver constructed bare in a unit test is a legitimate shape;
      // every pre-existing driver test does exactly that. `app()` throws in
      // that state, so the helper must swallow it.
      clearCurrentApp();

      await expect(
        fireMfaEvent(new MethodEnrolled("user-1", "totp", "m1", null)),
      ).resolves.toBeUndefined();
    });

    it("propagates a throwing listener to the caller", async () => {
      // The deliberate divergence from queue's fireJobEvent(), which
      // swallows. MFA is held to authentication's standard: a listener can
      // refuse an action, and one that cannot record a second-factor change
      // stops the change it failed to record.
      dispatcher.listen(MethodEnrolled, () => {
        throw new Error("listener exploded");
      });

      await expect(
        fireMfaEvent(new MethodEnrolled("user-1", "totp", "m1", null), database.app),
      ).rejects.toThrow("listener exploded");
    });

    it("resolves the dispatcher per call, so a swapped fake is seen", async () => {
      const replacement = new EventDispatcher(database.app);
      const captured: MfaEvent[] = [];
      replacement.listen(MfaEvent, (event) => void captured.push(event));
      database.app.instance(EVENTS_TOKEN, replacement);

      await fireMfaEvent(new MethodEnrolled("user-1", "totp", "m1", null), database.app);

      expect(captured).toHaveLength(1);
      expect(seen).toEqual([]);
    });
  });

  describe("every event", () => {
    it("extends MfaEvent, so one registration observes the subsystem", () => {
      const all = [
        new ChallengeIssued("u", "email", "i", "c", DateTime.now()),
        new ChallengeThrottled("u", "email", "i", 30),
        new IntentLocked("u", "totp", "i", 5),
        new MethodConfirmed("u", "totp", "m"),
        new MethodEnrolled("u", "totp", "m", null),
        new RecoveryCodeUsed("u", "i", 7),
        new RecoveryCodesGenerated("u", 8, 0),
        new VerificationFailed("u", "totp", "i", 1, 4),
        new Verified("u", "totp", "i", null),
      ];

      for (const event of all) {
        expect(event).toBeInstanceOf(MfaEvent);
        expect(event).toBeInstanceOf(AbstractEvent);
        expect(event.userId).toBe("u");
      }
    });

    it("names itself under the mfa.* namespace", () => {
      // An explicit static, not the class name: a minifier is free to
      // rewrite the latter, and the name is what patterns match and what
      // keys a queued listener's id.
      expect(new Verified("u", "totp", "i", null).eventName).toBe("mfa.Verified");
      expect(new MethodEnrolled("u", "totp", "m", null).eventName).toBe("mfa.MethodEnrolled");
      expect(new RecoveryCodeUsed("u", "i", 0).eventName).toBe("mfa.RecoveryCodeUsed");
    });

    it("is reachable by an mfa.* pattern, which is how a package with no mfa dependency subscribes", async () => {
      const matched: string[] = [];
      dispatcher.listen("mfa.*", (event) => void matched.push(event.eventName));

      await fireMfaEvent(new Verified("u", "totp", "i", null), database.app);

      expect(matched).toEqual(["mfa.Verified"]);
    });

    it("is silenced by Event.suppress(), like every other event family", async () => {
      // The property that only holds because these extend AbstractEvent.
      await AbstractEvent.suppress(async () => {
        await fireMfaEvent(new Verified("u", "totp", "i", null), database.app);
      });

      expect(seen).toEqual([]);
    });
  });

  describe("MfaManager.verify", () => {
    let manager: MfaManager;
    let stub: StubDriver;

    function build(maxAttempts = 3): MfaManager {
      const instance = new MfaManager(database.app, { drivers: ["stub"], maxAttempts });
      stub = new StubDriver();
      instance.extend("stub", () => stub);

      return instance;
    }

    beforeEach(() => {
      database.app.instance(AUTH_TOKEN, {
        userProvider: () => ({ retrieveById: async (id: string) => ({ id }) }),
        guard: () => ({}),
        getDefaultDriver: () => "web",
      });
      manager = build();
    });

    it("dispatches Verified with the intent's purpose", async () => {
      const intent = await makeIntent({ driver: "stub", purpose: "billing.payout" });

      await manager.verify(intent, "good");

      expect(only(Verified)).toHaveLength(1);
      expect(only(Verified)[0]).toMatchObject({
        userId: "user-1",
        driver: "stub",
        intentId: intent.id,
        purpose: "billing.payout",
      });
    });

    it("dispatches Verified once per intent, not once per submission", async () => {
      const intent = await makeIntent({ driver: "stub" });

      await manager.verify(intent, "good");
      await manager.verify(intent, "good");

      // The second call short-circuits on the already-verified status to
      // keep a double-click idempotent. A listener counting step-ups must
      // count step-ups, not clicks.
      expect(only(Verified)).toHaveLength(1);
    });

    it("dispatches VerificationFailed with the remaining allowance", async () => {
      const intent = await makeIntent({ driver: "stub" });
      stub.result = { status: "invalid-code" };

      await manager.verify(intent, "wrong");

      expect(only(VerificationFailed)[0]).toMatchObject({
        intentId: intent.id,
        attempts: 1,
        remaining: 2,
      });
      expect(only(IntentLocked)).toEqual([]);
    });

    it("dispatches IntentLocked alongside the failure that crosses the limit", async () => {
      const intent = await makeIntent({ driver: "stub", attempts: 2 });
      stub.result = { status: "invalid-code" };

      await manager.verify(intent, "wrong");

      // Two events out of one write. `countFailure()` fuses the increment
      // and the lock into a single UPDATE, so the lock is recovered from
      // the status it left behind.
      expect(only(VerificationFailed)[0]).toMatchObject({ attempts: 3, remaining: 0 });
      expect(only(IntentLocked)[0]).toMatchObject({ intentId: intent.id, attempts: 3 });
    });

    it("dispatches nothing for outcomes that are not a wrong guess", async () => {
      // These mirror exactly which outcomes count against `maxAttempts`. An
      // expired or missing challenge is not a guess, and an event here
      // would make the stream disagree with `attempts`.
      stub.result = { status: "expired" };
      await manager.verify(await makeIntent({ driver: "stub" }), "x");

      stub.result = { status: "no-challenge" };
      await manager.verify(await makeIntent({ driver: "stub" }), "x");

      stub.result = { status: "unavailable", reason: "nope" };
      await manager.verify(await makeIntent({ driver: "stub" }), "x");

      expect(seen).toEqual([]);
    });

    it("dispatches nothing when the intent has no driver chosen yet", async () => {
      await manager.verify(await makeIntent({ driver: null }), "x");

      expect(seen).toEqual([]);
    });

    it("dispatches nothing against an already-locked intent", async () => {
      await manager.verify(await makeIntent({ driver: "stub", status: "locked" }), "good");

      expect(seen).toEqual([]);
    });

    it("dispatches nothing for an expired intent", async () => {
      await manager.verify(await makeIntent({ driver: "stub", expiresInMinutes: -1 }), "good");

      expect(seen).toEqual([]);
    });
  });

  describe("TotpDriver", () => {
    let driver: TotpDriver;

    beforeEach(() => {
      driver = new TotpDriver(testEncrypter(), {});
    });

    it("dispatches MethodEnrolled for a not-yet-usable factor", async () => {
      const enrollment = await driver.enroll("user-1", "iPhone");

      // Deliberately reports an unconfirmed enrollment: an abandoned
      // hostile one is what an interrupted attacker leaves behind, and a
      // log that only recorded confirmation would never see it.
      expect(await driver.enrolled("user-1")).toBe(false);
      expect(only(MethodEnrolled)[0]).toMatchObject({
        userId: "user-1",
        driver: "totp",
        methodId: enrollment.methodId,
        label: "iPhone",
      });
    });

    it("never carries the secret", async () => {
      const enrollment = await driver.enroll("user-1");

      expect(JSON.stringify(only(MethodEnrolled)[0])).not.toContain(enrollment.secret);
    });

    it("dispatches MethodConfirmed only once the factor works", async () => {
      const enrollment = await driver.enroll("user-1");
      seen = [];

      await driver.confirm("user-1", enrollment.methodId, generateCode(enrollment.secret));

      expect(only(MethodConfirmed)[0]).toMatchObject({
        userId: "user-1",
        driver: "totp",
        methodId: enrollment.methodId,
      });
      expect(await driver.enrolled("user-1")).toBe(true);
    });

    it("dispatches nothing for a failed confirmation", async () => {
      const enrollment = await driver.enroll("user-1");
      seen = [];

      // `confirm()` returns false for a wrong code, a row belonging to
      // someone else and an already-confirmed row alike, so an event could
      // not say which happened.
      expect(await driver.confirm("user-1", enrollment.methodId, "000000")).toBe(false);
      expect(await driver.confirm("someone-else", enrollment.methodId, "000000")).toBe(false);

      expect(seen).toEqual([]);
    });
  });

  describe("EmailDriver", () => {
    let driver: EmailDriver;

    beforeEach(() => {
      driver = new EmailDriver(testHasher(), testSigner(), { throttleSeconds: 60 });
    });

    it("dispatches ChallengeIssued without the code", async () => {
      const intent = await makeIntent({ driver: "email" });
      const result = await driver.challenge({ intent, user: { email: "a@b.test" } });

      expect(result.status).toBe("issued");
      expect(only(ChallengeIssued)[0]).toMatchObject({
        userId: "user-1",
        driver: "email",
        intentId: intent.id,
      });

      // The code is the credential: it is returned to the caller to
      // deliver, and an event carrying it would spread it to every
      // listener and audit row.
      const code = result.status === "issued" ? result.code : "@@none@@";
      expect(JSON.stringify(only(ChallengeIssued)[0])).not.toContain(code);
    });

    it("dispatches ChallengeThrottled with the retry delay", async () => {
      const intent = await makeIntent({ driver: "email" });
      await driver.challenge({ intent, user: { email: "a@b.test" } });
      seen = [];

      const second = await driver.challenge({ intent, user: { email: "a@b.test" } });

      expect(second.status).toBe("throttled");
      expect(only(ChallengeThrottled)[0]).toMatchObject({ intentId: intent.id });
      expect(only(ChallengeThrottled)[0]!.retryAfterSeconds).toBeGreaterThan(0);
      expect(only(ChallengeIssued)).toEqual([]);
    });

    it("dispatches nothing when the account has no address", async () => {
      await driver.challenge({ intent: await makeIntent({ driver: "email" }), user: {} });

      expect(seen).toEqual([]);
    });
  });

  describe("RecoveryDriver", () => {
    let driver: RecoveryDriver;

    beforeEach(() => {
      driver = new RecoveryDriver({ count: 3 });
    });

    it("reports a first generation as replacing nothing", async () => {
      const codes = await driver.generate("user-1");

      expect(only(RecoveryCodesGenerated)[0]).toMatchObject({
        userId: "user-1",
        count: 3,
        replaced: 0,
      });

      // The codes exist exactly once, in the return value.
      for (const code of codes) {
        expect(JSON.stringify(only(RecoveryCodesGenerated)[0])).not.toContain(code);
      }
    });

    it("reports how many a regeneration replaced", async () => {
      await driver.generate("user-1");
      seen = [];

      await driver.generate("user-1");

      // The distinction is the point: a regeneration the user did not
      // perform is an attacker cutting off their recovery path.
      expect(only(RecoveryCodesGenerated)[0]).toMatchObject({ count: 3, replaced: 3 });
    });

    it("counts used codes among those replaced", async () => {
      const codes = await driver.generate("user-1");
      const intent = await makeIntent({ driver: "recovery" });
      await driver.verify({ intent, user: {}, code: codes[0]! });
      seen = [];

      await driver.generate("user-1");

      // Regenerating deletes the previous set used or not, so `replaced`
      // has to count both to be honest about what was discarded.
      expect(only(RecoveryCodesGenerated)[0]).toMatchObject({ replaced: 3 });
    });

    it("dispatches RecoveryCodeUsed with the count left afterwards", async () => {
      const codes = await driver.generate("user-1");
      const intent = await makeIntent({ driver: "recovery" });
      seen = [];

      await driver.verify({ intent, user: {}, code: codes[0]! });

      expect(only(RecoveryCodeUsed)[0]).toMatchObject({
        userId: "user-1",
        intentId: intent.id,
        remaining: 2,
      });
      expect(await MfaRecoveryCode.query().whereNull("used_at").count()).toBe(2);
    });

    it("reports zero remaining on the last code, the urgent case", async () => {
      const codes = await driver.generate("user-1");
      const intent = await makeIntent({ driver: "recovery" });

      for (const code of codes) {
        await driver.verify({ intent, user: {}, code });
      }

      expect(only(RecoveryCodeUsed).map((event) => event.remaining)).toEqual([2, 1, 0]);
    });

    it("dispatches nothing for a wrong code", async () => {
      await driver.generate("user-1");
      seen = [];

      await driver.verify({
        intent: await makeIntent({ driver: "recovery" }),
        user: {},
        code: "NOPE",
      });

      expect(seen).toEqual([]);
    });
  });
});
