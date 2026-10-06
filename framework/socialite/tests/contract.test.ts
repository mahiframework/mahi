import { randomBytes } from "node:crypto";
import { Signer } from "@mahiframework/encryption";
import type { Request } from "@mahiframework/http";
import { Http } from "@mahiframework/http-client";
import { afterEach, describe, expect, it } from "vitest";
import { GithubSocialiteDriver } from "../src/oauth2/drivers/github-driver.js";
import {
  defaultDriverOptions,
  Oauth2SocialiteDriver,
  type Oauth2DriverContext,
  type Oauth2DriverOptions,
} from "../src/oauth2/oauth2-socialite-driver.js";
import type { SocialiteDriver } from "../src/socialite-driver.js";
import type { MappedSocialiteUser } from "../src/socialite-user.js";
import {
  socialiteDriverContract,
  type ContractHarness,
} from "../src/testing/socialite-driver-contract.js";
import {
  callbackRequest,
  captureError,
  createHarness,
  githubConfig,
  GITHUB_STUBS,
  queuedCookies,
  redirectRequest,
  type Harness,
} from "./__fixtures__/test-app.js";
import type { SocialiteConfig } from "../src/socialite-config.js";

let harness: Harness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

function contractHarness(driver: () => SocialiteDriver<never>): ContractHarness<never> {
  return {
    driver,
    redirectRequest,
    callbackRequest: (options) => {
      const query: Record<string, string> = {};

      if (options.code !== undefined) {
        query.code = options.code;
      }

      if (options.state !== undefined) {
        query.state = options.state;
      }

      return callbackRequest(
        query,
        options.carry === undefined ? {} : queuedCookies(options.carry),
      );
    },
  };
}

/**
 * Every built-in driver, with the config and stubs it needs.
 *
 * The contract runs against all of them, which is the point of having
 * one: `GoogleSocialiteDriver` overrides the scope separator and
 * `refreshToken()`, so it is the first evidence that those extension
 * points do not break the guarantees.
 */
const PROVIDERS = {
  github: {
    config: githubConfig(),
    stubs: GITHUB_STUBS,
  },
  google: {
    config: {
      providers: {
        google: {
          clientId: "google-client-id",
          clientSecret: "google-client-secret",
          redirect: "https://app.test/auth/google/callback",
        },
      },
      cookie: { secure: false },
    } satisfies SocialiteConfig,
    stubs: {
      "oauth2.googleapis.com/token": { access_token: "ya29.token", scope: "openid email" },
      "openidconnect.googleapis.com/v1/userinfo": { sub: "42", name: "Grace Hopper" },
    },
  },
} as const;

/**
 * The real driver, from the harness built for the current test.
 *
 * `driver()` is called several times within one case, so it must return
 * the *same* signing key each time — a fresh harness per call would mint
 * a new one and every state cookie would read as `unsigned`.
 */
function builtIn(name: keyof typeof PROVIDERS): () => SocialiteDriver<never> {
  return () => {
    harness ??= createHarness(PROVIDERS[name].config);

    return harness.manager.driver(name) as unknown as SocialiteDriver<never>;
  };
}

for (const name of Object.keys(PROVIDERS) as (keyof typeof PROVIDERS)[]) {
  describe(`${name} satisfies the driver contract`, () => {
    for (const contractCase of socialiteDriverContract(contractHarness(builtIn(name)))) {
      it(contractCase.name, async () => {
        harness = createHarness(PROVIDERS[name].config);
        Http.fake(PROVIDERS[name].stubs);

        await contractCase.run();
      });
    }
  });
}

// ---------------------------------------------------------------------
// The contract has to be able to FAIL. A contract that cannot is
// decoration, so each deliberately-broken driver below is checked to
// trip at least one case.
// ---------------------------------------------------------------------

function brokenContext(): Oauth2DriverContext {
  return {
    name: "broken",
    clientId: "id",
    clientSecret: "secret",
    resolveRedirectUrl: () => "https://app.test/cb",
    signer: new Signer(randomBytes(32)).for("socialite"),
    cookie: { secure: false },
  };
}

/** Mutates itself instead of returning a copy — the singleton-leak bug. */
class MutatingDriver extends Oauth2SocialiteDriver<never> {
  private mutableScopes: string[] = ["base"];

  protected meta() {
    return { name: "Mutating", website: "https://mutating.test" };
  }

  protected withOptions(options: Oauth2DriverOptions): SocialiteDriver<never> {
    return new MutatingDriver(this.context, options);
  }

  override getScopes(): readonly string[] {
    return this.mutableScopes;
  }

  override scopes(scopes: string | string[]): SocialiteDriver<never> {
    this.mutableScopes = [
      ...this.mutableScopes,
      ...(typeof scopes === "string" ? [scopes] : scopes),
    ];

    return this;
  }

  protected authUrl(): string {
    return "https://mutating.test/authorize";
  }

  protected tokenUrl(): string {
    return "https://mutating.test/token";
  }

  protected async fetchUser(): Promise<never> {
    throw new Error("not reached");
  }

  protected mapUser(): MappedSocialiteUser {
    throw new Error("not reached");
  }
}

/** Skips the state check, accepting any callback. */
class NoStateCheckDriver extends GithubSocialiteDriver {
  override async user(request: Request) {
    const code = request.query("code");

    if (code === undefined) {
      throw new Error("no code");
    }

    return {
      id: "1",
      nickname: null,
      name: null,
      email: null,
      avatar: null,
      raw: {} as never,
      token: { token: "t", refreshToken: null, expiresIn: null, approvedScopes: [] },
    };
  }
}

/**
 * Issues the same state every time, so it is guessable — and ignores
 * `stateless()`, so the copy is broken too.
 */
class FixedStateDriver extends GithubSocialiteDriver {
  override async redirect(): Promise<string> {
    return "https://github.com/login/oauth/authorize?client_id=id&redirect_uri=https%3A%2F%2Fapp.test%2Fcb&response_type=code&state=always-the-same";
  }

  protected override withOptions(): SocialiteDriver<never> {
    return this as unknown as SocialiteDriver<never>;
  }
}

async function runContract(driver: () => SocialiteDriver<never>, only?: string): Promise<string[]> {
  const failures: string[] = [];

  for (const contractCase of socialiteDriverContract(contractHarness(driver))) {
    if (only !== undefined && contractCase.name !== only) {
      continue;
    }

    try {
      await contractCase.run();
    } catch (error) {
      failures.push(`${contractCase.name}: ${String(error)}`);
    }
  }

  return failures;
}

describe("the contract fails a broken driver", () => {
  it("catches a driver that mutates itself in scopes()", async () => {
    const driver = new MutatingDriver(brokenContext(), defaultDriverOptions());

    const failures = await runContract(
      () => driver,
      "scopes() merges and does not mutate the driver it was called on",
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("mutated the receiver");
  });

  it("catches a driver that does not verify state", async () => {
    harness = createHarness();

    const failures = await runContract(
      () =>
        new NoStateCheckDriver(
          brokenContext(),
          defaultDriverOptions(),
        ) as unknown as SocialiteDriver<never>,
      "user() rejects a callback with no state cookie",
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("nothing was thrown");
  });

  it("catches a driver that reuses the same state", async () => {
    harness = createHarness();

    const failures = await runContract(
      () =>
        new FixedStateDriver(
          brokenContext(),
          defaultDriverOptions(),
        ) as unknown as SocialiteDriver<never>,
      "redirect() issues a different state every time",
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("state was reused");
  });

  it("catches a driver whose stateless() still issues a state", async () => {
    harness = createHarness();

    const failures = await runContract(
      () =>
        new FixedStateDriver(
          brokenContext(),
          defaultDriverOptions(),
        ) as unknown as SocialiteDriver<never>,
      "stateless() issues no state parameter",
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("stateless driver issued a state");
  });

  it("reports a passing driver as having no failures", async () => {
    harness = createHarness();

    const failures = await runContract(builtIn("github"));

    expect(failures).toEqual([]);
  });
});

describe("captureError", () => {
  it("rejects when the promise unexpectedly resolves", async () => {
    await expect(captureError(Promise.resolve("fine"))).rejects.toThrow(
      "Expected the promise to reject",
    );
  });
});
