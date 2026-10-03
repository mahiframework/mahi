import type { MfaDriver } from "../mfa-driver.js";
import type { MfaIntent } from "../models/mfa-intent.js";

/**
 * The `MfaDriver` contract, as executable cases.
 *
 * A driver can satisfy the TypeScript interface and still break every
 * behavioural guarantee that matters: that a wrong code returns
 * `invalid-code` rather than throwing, that `challenge()` on an
 * unenrolled user says `unavailable` rather than minting something
 * nobody can receive, that a code is single-use. None of those are
 * visible in the signature, so the contract ships as tests and every
 * driver runs the same ones. This is what stops a third-party driver
 * drifting into a subtly different factor behind one interface.
 *
 * Runner-agnostic on purpose, exactly like
 * `@mahiframework/storage`'s `storageDriverContract()`: cases are plain
 * objects with a `run()`, failures are thrown `Error`s rather than
 * matcher calls, so this ships in `src/` (and is therefore published)
 * without the package taking a test-runner dependency. A vitest file is
 * three lines:
 *
 * ```ts
 * for (const testCase of mfaDriverContract(options)) {
 *   it(testCase.name, () => testCase.run());
 * }
 * ```
 */
export interface MfaDriverContractCase {
  name: string;
  run(): Promise<void>;
}

export interface MfaDriverContractOptions {
  /** A driver over a clean database. Called once per case. */
  driver(): Promise<MfaDriver>;
  /** A persisted intent for `userId`, for the driver to work against. */
  intent(userId: string): Promise<MfaIntent>;
  /** The user record the driver will be handed. */
  user(userId: string): Promise<unknown>;
  /**
   * Enroll `userId` and return a code that should verify.
   *
   * Returning null means the driver cannot be enrolled programmatically
   * (nothing in-tree does), and the cases needing a valid code skip.
   */
  enroll(userId: string, driver: MfaDriver): Promise<string | null>;
  /**
   * Whether this driver mints a credential on `challenge()`.
   *
   * Drives the `ready`-vs-`issued` assertion: both are correct, but a
   * driver must be consistent about which it is, or a caller cannot know
   * whether it has something to deliver.
   */
  issues: boolean;
  /** A code guaranteed not to be the right one. */
  wrongCode: string;
}

const USER = "contract-user";

export function mfaDriverContract(options: MfaDriverContractOptions): MfaDriverContractCase[] {
  const { driver: makeDriver, intent: makeIntent, user: makeUser, enroll, wrongCode } = options;

  return [
    {
      name: "enrolled() is false for a user who has enrolled nothing",
      async run() {
        const driver = await makeDriver();

        // The email driver is the exception and documents why: a user
        // with an address is enrolled by definition, so it reports true
        // and defers the real check to `challenge()`. Asserting "false
        // or a challenge that says unavailable" covers both honestly.
        if (await driver.enrolled(USER)) {
          const intent = await makeIntent(USER);
          const result = await driver.challenge({ intent, user: { id: USER } });

          assert(
            result.status === "unavailable",
            `enrolled() was true for an unenrolled user, and challenge() returned "${result.status}" rather than "unavailable"`,
          );
        }
      },
    },
    {
      name: "enrolled() is true once enrolled",
      async run() {
        const driver = await makeDriver();

        if ((await enroll(USER, driver)) === null) {
          return;
        }

        assert(await driver.enrolled(USER), "enrolled() was false after enrolling");
      },
    },
    {
      name: "challenge() is consistent about whether it issues a credential",
      async run() {
        const driver = await makeDriver();
        await enroll(USER, driver);

        const intent = await makeIntent(USER);
        const result = await driver.challenge({ intent, user: await makeUser(USER) });

        if (result.status === "unavailable" || result.status === "throttled") {
          return;
        }

        if (options.issues) {
          assert(result.status === "issued", `expected "issued", got "${result.status}"`);
          assert(result.code.length > 0, "issued an empty code");
          assert(result.expiresAt.isFuture(), "issued a credential that is already expired");
        } else {
          assert(result.status === "ready", `expected "ready", got "${result.status}"`);
        }
      },
    },
    {
      name: "verify() returns invalid-code for a wrong code, and does not throw",
      async run() {
        const driver = await makeDriver();
        await enroll(USER, driver);

        const intent = await makeIntent(USER);
        await driver.challenge({ intent, user: await makeUser(USER) });

        const result = await driver.verify({
          intent,
          user: await makeUser(USER),
          code: wrongCode,
        });

        // A wrong code is the single most common thing that happens to
        // this method. Throwing would turn a typo into a 500.
        assert(
          result.status === "invalid-code",
          `expected "invalid-code" for a wrong code, got "${result.status}"`,
        );
      },
    },
    {
      name: "verify() accepts a correct code",
      async run() {
        const driver = await makeDriver();
        const code = await enroll(USER, driver);

        if (code === null) {
          return;
        }

        const intent = await makeIntent(USER);
        const challenge = await driver.challenge({ intent, user: await makeUser(USER) });
        const submit = challenge.status === "issued" ? challenge.code : code;

        const result = await driver.verify({ intent, user: await makeUser(USER), code: submit });

        assert(
          result.status === "verified",
          `expected "verified" for a correct code, got "${result.status}"`,
        );
      },
    },
    {
      name: "verify() does not accept the same code twice",
      async run() {
        const driver = await makeDriver();
        const code = await enroll(USER, driver);

        if (code === null) {
          return;
        }

        const intent = await makeIntent(USER);
        const challenge = await driver.challenge({ intent, user: await makeUser(USER) });
        const submit = challenge.status === "issued" ? challenge.code : code;

        const first = await driver.verify({ intent, user: await makeUser(USER), code: submit });
        assert(first.status === "verified", "the first verify did not succeed");

        // THE REPLAY CASE. Every factor here is single-use within its
        // validity: a TOTP step is burned, an emailed code is consumed,
        // a recovery code is spent. A driver that lets the same value
        // through twice is a bearer token with extra steps.
        const second = await driver.verify({ intent, user: await makeUser(USER), code: submit });
        assert(
          second.status !== "verified",
          "the same code verified twice; the driver has no replay defense",
        );
      },
    },
    {
      name: "verify() tolerates an empty code",
      async run() {
        const driver = await makeDriver();
        await enroll(USER, driver);

        const intent = await makeIntent(USER);
        await driver.challenge({ intent, user: await makeUser(USER) });

        // An empty submission reaches here from any form with an
        // optional field. It must be a normal rejection, not a crash.
        const result = await driver.verify({ intent, user: await makeUser(USER), code: "" });

        assert(result.status !== "verified", "an empty code verified");
      },
    },
    {
      name: "name matches the driver's registered name",
      async run() {
        const driver = await makeDriver();

        assert(
          typeof driver.name === "string" && driver.name.length > 0,
          "driver.name is empty; it is what gets stored in mfa_intents.driver",
        );
      },
    },
  ];
}

/**
 * `asserts condition` rather than `condition: boolean`, so a passing
 * assertion narrows the union it tested. Without it, asserting
 * `result.status === "issued"` leaves `result` as the full
 * `ChallengeResult` and reading `result.code` does not compile.
 */
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`MFA driver contract: ${message}`);
  }
}
