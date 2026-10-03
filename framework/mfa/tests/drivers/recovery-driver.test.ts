import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecoveryDriver } from "../../src/drivers/recovery-driver.js";
import { MfaRecoveryCode } from "../../src/models/mfa-recovery-code.js";
import {
  createTestDatabase,
  makeIntent,
  type TestDatabase,
} from "../__fixtures__/test-database.js";

describe("RecoveryDriver", () => {
  let database: TestDatabase;
  let driver: RecoveryDriver;
  const user = { id: "user-1" };

  beforeEach(async () => {
    database = await createTestDatabase();
    driver = new RecoveryDriver();
  });

  afterEach(() => database.cleanup());

  describe("generate", () => {
    it("returns the configured number of codes", async () => {
      expect(await driver.generate(user.id)).toHaveLength(8);
      expect(await new RecoveryDriver({ count: 3 }).generate("other")).toHaveLength(3);
    });

    it("returns codes in an unambiguous alphabet", async () => {
      // These get read aloud and typed by hand, so the base32 alphabet's
      // exclusion of 0/O and 1/I is the point.
      for (const code of await driver.generate(user.id)) {
        expect(code).toMatch(/^[A-Z2-7]+$/);
      }
    });

    it("does not repeat a code", async () => {
      const codes = await driver.generate(user.id);

      expect(new Set(codes).size).toBe(codes.length);
    });

    it("stores only hashes, never the plaintext", async () => {
      const codes = await driver.generate(user.id);
      const stored = (await MfaRecoveryCode.query().where("user_id", "=", user.id).get()).all();

      for (const record of stored) {
        expect(codes).not.toContain(record.code);
        // SHA-256 hex, not argon2: a 20-byte random code has no
        // low-entropy keyspace for a slow hash to protect.
        expect(record.code).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it("REPLACES the previous set", async () => {
      // A user regenerates because they believe the old list is lost or
      // compromised; leaving any of it live would defeat the exercise.
      const first = await driver.generate(user.id);
      await driver.generate(user.id);

      const intent = await makeIntent({ driver: "recovery" });
      expect(await driver.verify({ intent, user, code: first[0]! })).toEqual({
        status: "invalid-code",
      });
    });
  });

  describe("enrolled", () => {
    it("is false with no codes", async () => {
      expect(await driver.enrolled(user.id)).toBe(false);
    });

    it("is true while unused codes remain", async () => {
      await driver.generate(user.id);

      expect(await driver.enrolled(user.id)).toBe(true);
    });

    it("is false once every code is spent", async () => {
      const codes = await new RecoveryDriver({ count: 2 }).generate(user.id);

      for (const code of codes) {
        const intent = await makeIntent({ driver: "recovery" });
        await driver.verify({ intent, user, code });
      }

      expect(await driver.enrolled(user.id)).toBe(false);
    });
  });

  describe("remaining", () => {
    it("counts down as codes are used", async () => {
      const codes = await new RecoveryDriver({ count: 3 }).generate(user.id);
      expect(await driver.remaining(user.id)).toBe(3);

      const intent = await makeIntent({ driver: "recovery" });
      await driver.verify({ intent, user, code: codes[0]! });

      expect(await driver.remaining(user.id)).toBe(2);
    });
  });

  describe("challenge", () => {
    it("is ready when codes remain, minting nothing", async () => {
      await driver.generate(user.id);
      const intent = await makeIntent({ driver: "recovery" });

      expect(await driver.challenge({ intent, user })).toEqual({ status: "ready" });
    });

    it("is unavailable with no codes", async () => {
      const intent = await makeIntent({ driver: "recovery" });

      expect(await driver.challenge({ intent, user })).toMatchObject({ status: "unavailable" });
    });
  });

  describe("verify", () => {
    it("accepts any unused code", async () => {
      const codes = await driver.generate(user.id);

      for (const code of [codes[0]!, codes[3]!, codes[7]!]) {
        const intent = await makeIntent({ driver: "recovery" });
        expect(await driver.verify({ intent, user, code })).toEqual({ status: "verified" });
      }
    });

    it("is SINGLE USE", async () => {
      const codes = await driver.generate(user.id);

      const first = await makeIntent({ driver: "recovery" });
      expect(await driver.verify({ intent: first, user, code: codes[0]! })).toEqual({
        status: "verified",
      });

      const second = await makeIntent({ driver: "recovery" });
      expect(await driver.verify({ intent: second, user, code: codes[0]! })).toEqual({
        status: "invalid-code",
      });
    });

    it("marks the code used rather than deleting it", async () => {
      // So the user can still be told how many they have burned, which
      // is the signal to regenerate.
      const codes = await driver.generate(user.id);
      const intent = await makeIntent({ driver: "recovery" });
      await driver.verify({ intent, user, code: codes[0]! });

      const used = (
        await MfaRecoveryCode.query().where("user_id", "=", user.id).whereNotNull("used_at").get()
      ).all();

      expect(used).toHaveLength(1);
    });

    it("rejects a wrong code", async () => {
      await driver.generate(user.id);
      const intent = await makeIntent({ driver: "recovery" });

      expect(await driver.verify({ intent, user, code: "AAAAAAAAAAAAAAAA" })).toEqual({
        status: "invalid-code",
      });
    });

    it("tolerates the spacing and casing of a code read off a printout", async () => {
      const codes = await driver.generate(user.id);
      const code = codes[0]!;
      const mangled = `${code.slice(0, 4)} ${code.slice(4, 8)}-${code.slice(8)}`.toLowerCase();

      const intent = await makeIntent({ driver: "recovery" });
      expect(await driver.verify({ intent, user, code: mangled })).toEqual({
        status: "verified",
      });
    });

    it("does not accept another user's code", async () => {
      const mine = await driver.generate(user.id);
      await driver.generate("someone-else");

      const intent = await makeIntent({ userId: "someone-else", driver: "recovery" });
      expect(await driver.verify({ intent, user: { id: "someone-else" }, code: mine[0]! })).toEqual(
        { status: "invalid-code" },
      );
    });

    it("is unavailable with no codes at all", async () => {
      const intent = await makeIntent({ driver: "recovery" });

      expect(await driver.verify({ intent, user, code: "AAAA" })).toMatchObject({
        status: "unavailable",
      });
    });

    it("rejects an empty code", async () => {
      await driver.generate(user.id);
      const intent = await makeIntent({ driver: "recovery" });

      expect(await driver.verify({ intent, user, code: "" })).toEqual({
        status: "invalid-code",
      });
    });
  });
});
