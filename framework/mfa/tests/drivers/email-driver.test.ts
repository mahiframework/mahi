import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "@mahiframework/datetime";
import { EmailDriver } from "../../src/drivers/email-driver.js";
import { MfaChallenge } from "../../src/models/mfa-challenge.js";
import {
  createTestDatabase,
  makeIntent,
  testHasher,
  testSigner,
  type TestDatabase,
} from "../__fixtures__/test-database.js";

describe("EmailDriver", () => {
  let database: TestDatabase;
  let driver: EmailDriver;
  const user = { id: "user-1", email: "user@example.com" };

  beforeEach(async () => {
    database = await createTestDatabase();
    driver = new EmailDriver(testHasher(), testSigner(), {});
  });

  afterEach(() => database.cleanup());

  describe("challenge", () => {
    it("issues a code of the configured length", async () => {
      const intent = await makeIntent({ driver: "email" });
      const result = await driver.challenge({ intent, user });

      expect(result.status).toBe("issued");

      if (result.status !== "issued") {
        return;
      }

      expect(result.code).toMatch(/^\d{6}$/);
      expect(result.expiresAt.isFuture()).toBe(true);
    });

    it("stores the code hashed, never in the clear", async () => {
      const intent = await makeIntent({ driver: "email" });
      const result = await driver.challenge({ intent, user });

      const stored = (await MfaChallenge.query().where("intent_id", "=", intent.id).first())!;

      expect(result.status === "issued" && stored.code).not.toBe(
        result.status === "issued" ? result.code : "",
      );
      expect(stored.code).toMatch(/^\$argon2/);
    });

    it("is unavailable when the account has no address", async () => {
      const intent = await makeIntent({ driver: "email" });

      expect(await driver.challenge({ intent, user: { id: "user-1" } })).toMatchObject({
        status: "unavailable",
      });
    });

    it("treats a blank address as absent", async () => {
      // Sending to "" would throw deep inside a transport instead of
      // reporting a usable reason here.
      const intent = await makeIntent({ driver: "email" });

      expect(
        await driver.challenge({ intent, user: { id: "user-1", email: "   " } }),
      ).toMatchObject({ status: "unavailable" });
    });

    it("reads a configured non-default column", async () => {
      const custom = new EmailDriver(testHasher(), testSigner(), { column: "mfa_email" });
      const intent = await makeIntent({ driver: "email" });

      const result = await custom.challenge({
        intent,
        user: { id: "user-1", mfa_email: "other@example.com" },
      });

      expect(result.status).toBe("issued");
    });

    it("throttles a second issue for the same intent", async () => {
      const intent = await makeIntent({ driver: "email" });
      await driver.challenge({ intent, user });

      const second = await driver.challenge({ intent, user });

      expect(second.status).toBe("throttled");

      if (second.status === "throttled") {
        expect(second.retryAfterSeconds).toBeGreaterThan(0);
        expect(second.retryAfterSeconds).toBeLessThanOrEqual(60);
      }
    });

    it("does not throttle when throttling is disabled", async () => {
      const unthrottled = new EmailDriver(testHasher(), testSigner(), { throttleSeconds: 0 });
      const intent = await makeIntent({ driver: "email" });

      await unthrottled.challenge({ intent, user });

      expect((await unthrottled.challenge({ intent, user })).status).toBe("issued");
    });

    it("omits the link by default", async () => {
      // A link is clickable from anywhere, so the session binding cannot
      // hold on that path; it is opt-in for that reason.
      const intent = await makeIntent({ driver: "email" });
      const result = await driver.challenge({ intent, user });

      expect(result.status === "issued" && result.url).toBeUndefined();
    });

    it("includes a signed link when configured to", async () => {
      const linked = new EmailDriver(testHasher(), testSigner(), { link: true });
      const intent = await makeIntent({ driver: "email" });
      const result = await linked.challenge({ intent, user });

      expect(result.status).toBe("issued");

      if (result.status !== "issued") {
        return;
      }

      expect(result.url).toBeDefined();
      expect(result.url).toContain(intent.id);
      // Signed, so a client cannot forge one for another intent.
      expect(result.url).toMatch(/\.[A-Za-z0-9_-]+$/);
    });
  });

  describe("verify", () => {
    /** Issue a code and hand back the plaintext. */
    async function issued(intentDriver = driver) {
      const intent = await makeIntent({ driver: "email" });
      const result = await intentDriver.challenge({ intent, user });

      if (result.status !== "issued") {
        throw new Error(`expected an issued challenge, got ${result.status}`);
      }

      return { intent, code: result.code };
    }

    it("accepts the issued code", async () => {
      const { intent, code } = await issued();

      expect(await driver.verify({ intent, user, code })).toEqual({ status: "verified" });
    });

    it("rejects a wrong code", async () => {
      const { intent, code } = await issued();
      const wrong = code === "000000" ? "111111" : "000000";

      expect(await driver.verify({ intent, user, code: wrong })).toEqual({
        status: "invalid-code",
      });
    });

    it("counts a failed attempt against the challenge", async () => {
      const { intent, code } = await issued();
      const wrong = code === "000000" ? "111111" : "000000";

      await driver.verify({ intent, user, code: wrong });

      const stored = (await MfaChallenge.query().where("intent_id", "=", intent.id).first())!;
      expect(stored.attempts).toBe(1);
    });

    it("tolerates surrounding whitespace in a pasted code", async () => {
      const { intent, code } = await issued();

      expect(await driver.verify({ intent, user, code: ` ${code} ` })).toEqual({
        status: "verified",
      });
    });

    it("reports no-challenge when none was issued", async () => {
      const intent = await makeIntent({ driver: "email" });

      expect(await driver.verify({ intent, user, code: "123456" })).toEqual({
        status: "no-challenge",
      });
    });

    it("CONSUMES the code, so it cannot be used twice", async () => {
      const { intent, code } = await issued();

      expect(await driver.verify({ intent, user, code })).toEqual({ status: "verified" });
      // Second use must fail. Consumed rather than deleted, so this is
      // `no-challenge` rather than silently succeeding.
      expect(await driver.verify({ intent, user, code })).toEqual({ status: "no-challenge" });
    });

    it("rejects an expired code", async () => {
      const { intent } = await issued();

      await MfaChallenge.query()
        .where("intent_id", "=", intent.id)
        .update({ expires_at: DateTime.now().subMinutes(1) });

      expect(await driver.verify({ intent, user, code: "123456" })).toEqual({ status: "expired" });
    });

    it("does not accept another intent's code", async () => {
      const first = await issued();
      const second = await makeIntent({ driver: "email" });
      await driver.challenge({ intent: second, user });

      expect(await driver.verify({ intent: second, user, code: first.code })).toEqual({
        status: "invalid-code",
      });
    });

    it("rejects an empty code", async () => {
      const { intent } = await issued();

      expect(await driver.verify({ intent, user, code: "" })).toEqual({
        status: "invalid-code",
      });
    });
  });

  describe("enrolled", () => {
    it("is true, deferring the real check to challenge()", async () => {
      // Implicit enrollment: a user with an address needs no setup. The
      // id alone cannot reveal whether an address exists, so answering
      // false here would hide the driver from every user's method list.
      expect(await driver.enrolled("anyone")).toBe(true);
    });
  });
});
