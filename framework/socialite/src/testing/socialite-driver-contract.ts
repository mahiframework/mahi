import type { Request } from "@mahiframework/http";
import { InvalidStateError } from "../errors.js";
import type { SocialiteDriver } from "../socialite-driver.js";

/** One behavioural guarantee, as a name and a check that throws on failure. */
export interface ContractCase {
  readonly name: string;
  run(): Promise<void>;
}

export interface ContractHarness<TRaw = Record<string, unknown>> {
  /** A freshly resolved driver. Called per case, so cases cannot interfere. */
  driver(): SocialiteDriver<TRaw>;
  /** A request standing in for the initial "send me to the provider" hit. */
  redirectRequest(): Request;
  /**
   * A request standing in for the provider's callback.
   *
   * `carry` is the redirect request whose queued state cookie should be
   * presented, the way a browser would. Omit it to simulate a callback
   * arriving with no cookie at all. Building the cookie header is the
   * harness's job because only it knows how its requests are made, and
   * that round trip is the thing under test — so it must be real rather
   * than stubbed.
   */
  callbackRequest(options: { code?: string; state?: string; carry?: Request }): Request;
}

/**
 * Behavioural guarantees every `SocialiteDriver` must satisfy.
 *
 * Runner-agnostic plain objects with a `run()`, the shape
 * `storageDriverContract()` established, and for the same reason: a
 * driver that satisfies the TypeScript interface can still miss every
 * one of these. Types cannot express "does not mutate itself" or
 * "rejects a forged state".
 *
 * Verified to actually fail a broken driver before being relied on — see
 * `tests/contract.test.ts`. A contract that cannot fail is decoration.
 */
export function socialiteDriverContract<TRaw>(
  harness: ContractHarness<TRaw>,
): readonly ContractCase[] {
  return [
    {
      name: "redirect() returns an absolute https URL carrying client_id and redirect_uri",
      async run() {
        const url = new URL(await harness.driver().redirect(harness.redirectRequest()));

        assert(url.protocol === "https:", `expected https, got ${url.protocol}`);
        assert(url.searchParams.get("client_id") !== null, "no client_id");
        assert(url.searchParams.get("redirect_uri") !== null, "no redirect_uri");
        assert(url.searchParams.get("response_type") === "code", "response_type should be `code`");
      },
    },
    {
      name: "redirect() issues a state parameter by default",
      async run() {
        const url = new URL(await harness.driver().redirect(harness.redirectRequest()));

        assert(url.searchParams.get("state") !== null, "no state parameter");
      },
    },
    {
      name: "redirect() issues a different state every time",
      async run() {
        const first = new URL(await harness.driver().redirect(harness.redirectRequest()));
        const second = new URL(await harness.driver().redirect(harness.redirectRequest()));

        assert(
          first.searchParams.get("state") !== second.searchParams.get("state"),
          "state was reused across two redirects",
        );
      },
    },
    {
      name: "stateless() issues no state parameter",
      async run() {
        const driver = harness.driver().stateless();
        const url = new URL(await driver.redirect(harness.redirectRequest()));

        assert(url.searchParams.get("state") === null, "stateless driver issued a state");
      },
    },
    {
      name: "user() rejects a callback with no state cookie",
      async run() {
        const callback = harness.callbackRequest({ code: "abc", state: "forged" });

        await assertThrowsInvalidState(() => harness.driver().user(callback), "missing");
      },
    },
    {
      name: "user() rejects a callback whose state does not match",
      async run() {
        const redirect = harness.redirectRequest();
        await harness.driver().redirect(redirect);

        const callback = harness.callbackRequest({
          code: "abc",
          state: "not-the-issued-state",
          carry: redirect,
        });

        await assertThrowsInvalidState(() => harness.driver().user(callback), "mismatch");
      },
    },
    {
      name: "user() accepts a callback whose state matches",
      async run() {
        const { callback } = await completeRedirect(harness);

        const user = await harness.driver().user(callback);

        assert(
          typeof user.id === "string" && user.id !== "",
          "user.id should be a non-empty string",
        );
        assert(typeof user.token.token === "string", "user.token.token should be a string");
        assert(Array.isArray(user.token.approvedScopes), "approvedScopes should be an array");
      },
    },
    {
      name: "user() normalises id to a string",
      async run() {
        const { callback } = await completeRedirect(harness);
        const user = await harness.driver().user(callback);

        assert(typeof user.id === "string", `id was ${typeof user.id}, expected string`);
      },
    },
    {
      name: "the state cookie is single-use, so a replayed callback fails",
      async run() {
        const { callback, state } = await completeRedirect(harness);
        await harness.driver().user(callback);

        // A second callback presenting the same state, but without the
        // cookie (which the first call cleared).
        const replay = harness.callbackRequest({ code: "abc", state });

        await assertThrowsInvalidState(() => harness.driver().user(replay), "missing");
      },
    },
    {
      name: "scopes() merges and does not mutate the driver it was called on",
      async run() {
        const driver = harness.driver();
        const before = [...driver.getScopes()];

        const widened = driver.scopes(["contract:extra"]);

        assert(
          driver.getScopes().join(",") === before.join(","),
          `scopes() mutated the receiver: ${before.join(",")} became ${driver.getScopes().join(",")}`,
        );
        assert(
          widened.getScopes().includes("contract:extra"),
          "the returned copy should carry the added scope",
        );
        assert(widened !== driver, "scopes() should return a new driver");

        for (const scope of before) {
          assert(widened.getScopes().includes(scope), `merge dropped the existing scope ${scope}`);
        }
      },
    },
    {
      name: "setScopes() replaces and does not mutate the driver it was called on",
      async run() {
        const driver = harness.driver();
        const before = [...driver.getScopes()];

        const replaced = driver.setScopes(["contract:only"]);

        assert(
          driver.getScopes().join(",") === before.join(","),
          "setScopes() mutated the receiver",
        );
        assert(
          replaced.getScopes().join(",") === "contract:only",
          `expected exactly the replacement, got ${replaced.getScopes().join(",")}`,
        );
      },
    },
    {
      name: "with() does not mutate the driver it was called on",
      async run() {
        const driver = harness.driver();

        const parameterised = driver.with({ prompt: "consent" });

        const original = new URL(await driver.redirect(harness.redirectRequest()));
        const copy = new URL(await parameterised.redirect(harness.redirectRequest()));

        assert(original.searchParams.get("prompt") === null, "with() mutated the receiver");
        assert(copy.searchParams.get("prompt") === "consent", "the copy lost the parameter");
      },
    },
    {
      name: "stateless() and withPkce() do not mutate the driver they were called on",
      async run() {
        const driver = harness.driver();
        const before = new URL(await driver.redirect(harness.redirectRequest()));

        driver.stateless();
        driver.withPkce();

        const after = new URL(await driver.redirect(harness.redirectRequest()));

        assert(after.searchParams.get("state") !== null, "stateless() mutated the receiver");

        // Compared against this driver's own baseline rather than
        // asserted absent: a provider may require PKCE (X does), in
        // which case a challenge is present before either call and its
        // presence afterwards proves nothing. What must not change is
        // whether there is one.
        assert(
          (after.searchParams.get("code_challenge") === null) ===
            (before.searchParams.get("code_challenge") === null),
          "withPkce() mutated the receiver",
        );
      },
    },
    {
      name: "withPkce() adds an S256 challenge",
      async run() {
        const driver = harness.driver().withPkce();
        const url = new URL(await driver.redirect(harness.redirectRequest()));

        assert(url.searchParams.get("code_challenge") !== null, "no code_challenge");
        assert(
          url.searchParams.get("code_challenge_method") === "S256",
          "code_challenge_method should be S256",
        );
      },
    },
    {
      name: "getName() and getWebsite() describe the provider",
      async run() {
        const driver = harness.driver();

        assert(driver.getName() !== "", "getName() should not be empty");
        assert(
          driver.getWebsite().startsWith("https://"),
          `getWebsite() should be an absolute https URL, got ${driver.getWebsite()}`,
        );
      },
    },
  ];
}

async function completeRedirect<TRaw>(
  harness: ContractHarness<TRaw>,
): Promise<{ callback: Request; state: string }> {
  const redirect = harness.redirectRequest();
  const url = new URL(await harness.driver().redirect(redirect));
  const state = url.searchParams.get("state");

  assert(state !== null, "redirect() issued no state, so this case cannot run");

  return { callback: harness.callbackRequest({ code: "abc", state, carry: redirect }), state };
}

async function assertThrowsInvalidState(
  operation: () => Promise<unknown>,
  reason: InvalidStateError["reason"],
): Promise<void> {
  let caught: unknown;
  let threw = false;

  try {
    await operation();
  } catch (error) {
    caught = error;
    threw = true;
  }

  assert(threw, `expected an InvalidStateError (${reason}), but nothing was thrown`);
  assert(
    caught instanceof InvalidStateError,
    `expected an InvalidStateError, got ${String(caught)}`,
  );
  assert(caught.reason === reason, `expected reason "${reason}", got "${caught.reason}"`);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Socialite driver contract: ${message}`);
  }
}
