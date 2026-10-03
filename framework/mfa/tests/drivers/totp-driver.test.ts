import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "@mahiframework/datetime";
import { TotpDriver } from "../../src/drivers/totp-driver.js";
import { MfaMethod } from "../../src/models/mfa-method.js";
import { generateCode, generateCodeForStep, timestepAt } from "../../src/totp/totp.js";
import {
  createTestDatabase,
  makeIntent,
  testEncrypter,
  type TestDatabase,
} from "../__fixtures__/test-database.js";

describe("TotpDriver", () => {
  let database: TestDatabase;
  let driver: TotpDriver;
  const user = { id: "user-1", email: "user@example.com" };

  beforeEach(async () => {
    database = await createTestDatabase();
    driver = new TotpDriver(testEncrypter(), { issuer: "Acme" });
  });

  afterEach(() => database.cleanup());

  /** Enroll and confirm in one step, which is the normal happy path. */
  async function enrolled(): Promise<{ methodId: string; secret: string }> {
    const enrollment = await driver.enroll(user.id, user.email);
    const confirmed = await driver.confirm(
      user.id,
      enrollment.methodId,
      generateCode(enrollment.secret),
    );

    expect(confirmed).toBe(true);

    return { methodId: enrollment.methodId, secret: enrollment.secret };
  }

  describe("enrollment", () => {
    it("is not enrolled before enrolling", async () => {
      expect(await driver.enrolled(user.id)).toBe(false);
    });

    it("returns a secret and a scannable URI", async () => {
      const enrollment = await driver.enroll(user.id, user.email);

      expect(enrollment.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(enrollment.uri).toContain("otpauth://totp/Acme:");
      expect(enrollment.uri).toContain(`secret=${enrollment.secret}`);
    });

    it("is STILL not enrolled until the enrollment is confirmed", async () => {
      // The whole reason `confirmed_at` exists. A user whose
      // authenticator scanned a stale QR has a method that can never
      // produce a valid code; treating it as enrolled locks them out of
      // an account it only appears to protect.
      await driver.enroll(user.id, user.email);

      expect(await driver.enrolled(user.id)).toBe(false);
    });

    it("becomes enrolled once a code is proved", async () => {
      await enrolled();

      expect(await driver.enrolled(user.id)).toBe(true);
    });

    it("refuses to confirm with a wrong code", async () => {
      const enrollment = await driver.enroll(user.id, user.email);

      expect(await driver.confirm(user.id, enrollment.methodId, "000000")).toBe(false);
      expect(await driver.enrolled(user.id)).toBe(false);
    });

    it("refuses to confirm another user's enrollment", async () => {
      const enrollment = await driver.enroll(user.id, user.email);

      expect(
        await driver.confirm("someone-else", enrollment.methodId, generateCode(enrollment.secret)),
      ).toBe(false);
    });

    it("refuses to confirm twice", async () => {
      const { methodId, secret } = await enrolled();

      expect(await driver.confirm(user.id, methodId, generateCode(secret))).toBe(false);
    });

    it("stores the secret encrypted, not in the clear", async () => {
      const enrollment = await driver.enroll(user.id, user.email);
      const method = (await MfaMethod.find(enrollment.methodId))!;

      expect(method.secret).not.toBe(enrollment.secret);
      expect(method.secret).not.toContain(enrollment.secret);
    });

    it("binds the ciphertext to its owner, so a row moved between users fails", async () => {
      // The AAD. Without it, copying a ciphertext into another user's row
      // would silently authenticate the wrong person.
      const enrollment = await driver.enroll(user.id, user.email);
      const method = (await MfaMethod.find(enrollment.methodId))!;

      await MfaMethod.create({
        id: "stolen",
        user_id: "attacker",
        driver: "totp",
        secret: method.secret,
        label: null,
        confirmed_at: DateTime.now(),
        last_used_timestep: null,
        created_at: DateTime.now(),
      });

      const intent = await makeIntent({ userId: "attacker", driver: "totp" });
      await expect(
        driver.verify({
          intent,
          user: { id: "attacker" },
          code: generateCode(enrollment.secret),
        }),
      ).rejects.toThrow();
    });

    it("sets the replay floor from the confirming code", async () => {
      // Otherwise the code used to confirm could immediately be replayed
      // to satisfy a verification.
      const { secret } = await enrolled();
      const intent = await makeIntent({ driver: "totp" });

      const result = await driver.verify({ intent, user, code: generateCode(secret) });

      expect(result.status).toBe("invalid-code");
    });
  });

  describe("challenge", () => {
    it("is unavailable when nothing is enrolled", async () => {
      const intent = await makeIntent({ driver: "totp" });

      expect(await driver.challenge({ intent, user })).toMatchObject({
        status: "unavailable",
      });
    });

    it("is ready when enrolled, minting nothing", async () => {
      await enrolled();
      const intent = await makeIntent({ driver: "totp" });

      // Nothing to deliver: the user's authenticator already holds the
      // secret. Writing a challenge row would imply otherwise.
      expect(await driver.challenge({ intent, user })).toEqual({ status: "ready" });
    });
  });

  describe("verify", () => {
    it("accepts a current code", async () => {
      const { secret } = await enrolled();
      const intent = await makeIntent({ driver: "totp" });

      // One step ahead of the confirming code, since confirming set the
      // replay floor at the current step.
      const code = generateCodeForStep(secret, timestepAt(Date.now() / 1000) + 1);

      expect(await driver.verify({ intent, user, code })).toEqual({ status: "verified" });
    });

    it("rejects a wrong code without throwing", async () => {
      await enrolled();
      const intent = await makeIntent({ driver: "totp" });

      expect(await driver.verify({ intent, user, code: "000000" })).toEqual({
        status: "invalid-code",
      });
    });

    it("is unavailable when nothing is enrolled", async () => {
      const intent = await makeIntent({ driver: "totp" });

      expect(await driver.verify({ intent, user, code: "000000" })).toMatchObject({
        status: "unavailable",
      });
    });

    it("REJECTS A REPLAYED CODE within the same window", async () => {
      // The single most important case in this file. A TOTP code is
      // valid for its whole period, so without the stored replay floor
      // the same code verifies repeatedly, and at the default window
      // that is up to 90 seconds of a reusable "second factor".
      const { secret, methodId } = await enrolled();
      const step = timestepAt(Math.floor(Date.now() / 1000)) + 1;
      const code = generateCodeForStep(secret, step);

      const first = await makeIntent({ driver: "totp" });
      expect(await driver.verify({ intent: first, user, code })).toEqual({ status: "verified" });

      expect((await MfaMethod.find(methodId))!.last_used_timestep).toBe(step);

      const second = await makeIntent({ driver: "totp" });
      expect(await driver.verify({ intent: second, user, code })).toEqual({
        status: "invalid-code",
      });
    });

    it("accepts a later code after one has been used", async () => {
      // Replay defense must not become a lockout: the NEXT period's code
      // has to work. Window 2 rather than the default 1, because
      // confirming already consumed the current step, so this needs two
      // distinct future steps and both must be inside the window. Real
      // clocks supply that by advancing; a test cannot.
      const wide = new TotpDriver(testEncrypter(), { window: 2 });
      const enrollment = await wide.enroll(user.id, user.email);
      const current = timestepAt(Math.floor(Date.now() / 1000));
      await wide.confirm(user.id, enrollment.methodId, generateCode(enrollment.secret));

      const first = await makeIntent({ driver: "totp" });
      expect(
        await wide.verify({
          intent: first,
          user,
          code: generateCodeForStep(enrollment.secret, current + 1),
        }),
      ).toEqual({ status: "verified" });

      const second = await makeIntent({ driver: "totp" });
      expect(
        await wide.verify({
          intent: second,
          user,
          code: generateCodeForStep(enrollment.secret, current + 2),
        }),
      ).toEqual({ status: "verified" });
    });

    it("verifies against any of several enrolled authenticators", async () => {
      // A phone and a tablet. Both are legitimate.
      const phone = await driver.enroll(user.id, "phone");
      await driver.confirm(user.id, phone.methodId, generateCode(phone.secret));
      const tablet = await driver.enroll(user.id, "tablet");
      await driver.confirm(user.id, tablet.methodId, generateCode(tablet.secret));

      const step = timestepAt(Math.floor(Date.now() / 1000)) + 1;

      const first = await makeIntent({ driver: "totp" });
      expect(
        await driver.verify({ intent: first, user, code: generateCodeForStep(phone.secret, step) }),
      ).toEqual({ status: "verified" });

      const second = await makeIntent({ driver: "totp" });
      expect(
        await driver.verify({
          intent: second,
          user,
          code: generateCodeForStep(tablet.secret, step),
        }),
      ).toEqual({ status: "verified" });
    });

    it("ignores an unconfirmed enrollment's codes", async () => {
      const pending = await driver.enroll(user.id, "never-confirmed");
      const intent = await makeIntent({ driver: "totp" });

      expect(
        await driver.verify({ intent, user, code: generateCode(pending.secret) }),
      ).toMatchObject({ status: "unavailable" });
    });
  });
});
