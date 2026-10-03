import { afterEach, beforeEach, describe, it } from "vitest";
import { mfaDriverContract } from "../src/testing/mfa-driver-contract.js";
import { TotpDriver } from "../src/drivers/totp-driver.js";
import { EmailDriver } from "../src/drivers/email-driver.js";
import { RecoveryDriver } from "../src/drivers/recovery-driver.js";
import { generateCode, generateCodeForStep, timestepAt } from "../src/totp/totp.js";
import type { MfaDriver } from "../src/mfa-driver.js";
import {
  createTestDatabase,
  makeIntent,
  testEncrypter,
  testHasher,
  testSigner,
  type TestDatabase,
} from "./__fixtures__/test-database.js";

/**
 * The shared contract, run against all three built-in drivers.
 *
 * This is what stops the three drifting into subtly different factors
 * behind one interface, and it is the suite a third-party driver runs to
 * prove it belongs. A driver can satisfy the TypeScript interface and
 * still break every guarantee here.
 */
describe("MfaDriver contract", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createTestDatabase();
  });

  afterEach(() => database.cleanup());

  describe("TotpDriver", () => {
    // Window 2 so the contract's "accept a correct code" case has a
    // future step available: enrolling consumes the current one.
    const make = async (): Promise<MfaDriver> => new TotpDriver(testEncrypter(), { window: 2 });

    for (const testCase of mfaDriverContract({
      driver: make,
      intent: (userId) => makeIntent({ userId, driver: "totp" }),
      user: async (userId) => ({ id: userId, email: `${userId}@x.test` }),
      issues: false,
      wrongCode: "000000",
      async enroll(userId, driver) {
        const totp = driver as TotpDriver;
        const enrollment = await totp.enroll(userId, `${userId}@x.test`);
        await totp.confirm(userId, enrollment.methodId, generateCode(enrollment.secret));

        // One step ahead of the one confirming just burned.
        return generateCodeForStep(
          enrollment.secret,
          timestepAt(Math.floor(Date.now() / 1000)) + 1,
        );
      },
    })) {
      it(testCase.name, () => testCase.run());
    }
  });

  describe("EmailDriver", () => {
    for (const testCase of mfaDriverContract({
      driver: async () => new EmailDriver(testHasher(), testSigner(), { throttleSeconds: 0 }),
      intent: (userId) => makeIntent({ userId, driver: "email" }),
      user: async (userId) => ({ id: userId, email: `${userId}@x.test` }),
      issues: true,
      wrongCode: "000000",
      // Implicit enrollment: there is nothing to set up, and the code
      // comes from `challenge()`, which the contract reads itself.
      enroll: async () => "",
    })) {
      it(testCase.name, () => testCase.run());
    }
  });

  describe("RecoveryDriver", () => {
    for (const testCase of mfaDriverContract({
      driver: async () => new RecoveryDriver(),
      intent: (userId) => makeIntent({ userId, driver: "recovery" }),
      user: async (userId) => ({ id: userId }),
      issues: false,
      wrongCode: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      async enroll(userId, driver) {
        const codes = await (driver as RecoveryDriver).generate(userId);

        return codes[0]!;
      },
    })) {
      it(testCase.name, () => testCase.run());
    }
  });
});
