import { Http } from "@mahiframework/http-client";
import { afterEach, describe, expect, it } from "vitest";
import {
  socialiteDriverContract,
  type ContractHarness,
} from "../src/testing/socialite-driver-contract.js";
import type { SocialiteDriver } from "../src/socialite-driver.js";
import type { SocialiteProviderConfig } from "../src/socialite-config.js";
import {
  callbackRequest,
  createHarness,
  queuedCookies,
  redirectRequest,
  roundTrip,
  stateOf,
  type Harness,
} from "./__fixtures__/test-app.js";
import {
  configFor,
  PROVIDERS,
  PROVIDER_NAMES,
  type ProviderName,
} from "./__fixtures__/providers.js";

const NAMES: readonly ProviderName[] = PROVIDER_NAMES;

let harness: Harness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

/** A harness and driver for `name`, built once per test. */
function setup(name: ProviderName): Harness {
  harness = createHarness(configFor(name));
  Http.fake(PROVIDERS[name].stubs);

  return harness;
}

function driverFor(name: ProviderName): () => SocialiteDriver<never> {
  return () => {
    harness ??= setup(name);

    return harness.manager.driver(name) as unknown as SocialiteDriver<never>;
  };
}

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

// Every driver runs the same behavioural contract. This is the whole
// argument for having one: nine providers, one set of guarantees, and a
// new driver cannot ship without satisfying them.
describe.each(NAMES)("%s satisfies the driver contract", (name) => {
  for (const contractCase of socialiteDriverContract(contractHarness(driverFor(name)))) {
    it(contractCase.name, async () => {
      setup(name);

      await contractCase.run();
    });
  }
});

describe.each(NAMES)("%s", (name) => {
  const fixture = PROVIDERS[name];

  it("describes itself", () => {
    const driver = setup(name).manager.driver(name);

    expect({ name: driver.getName(), website: driver.getWebsite() }).toEqual(fixture.meta);
  });

  it("requests its default scopes, joined with its own separator", async () => {
    const driver = setup(name).manager.driver(name);

    expect(driver.getScopes()).toEqual(fixture.defaultScopes);

    const url = new URL(await driver.redirect(redirectRequest()));

    expect(url.searchParams.get("scope")).toBe(fixture.defaultScopes.join(fixture.scopeSeparator));
  });

  it("points at its own authorization endpoint", async () => {
    const url = new URL(await setup(name).manager.driver(name).redirect(redirectRequest()));

    expect(`${url.origin}${url.pathname}`).toBe(fixture.authUrl);
  });

  it("resolves a user through a full round trip", async () => {
    const instance = setup(name);
    const user = await instance.manager
      .driver(name)
      .user(await roundTrip(instance, { driver: name }));

    expect({
      id: user.id,
      nickname: user.nickname,
      name: user.name,
      email: user.email,
      avatar: user.avatar,
    }).toEqual(fixture.expected);
  });

  it("normalises id to a string", async () => {
    const instance = setup(name);
    const user = await instance.manager
      .driver(name)
      .user(await roundTrip(instance, { driver: name }));

    expect(typeof user.id).toBe("string");
  });

  it("exchanges the code at its own token endpoint", async () => {
    const instance = setup(name);

    await instance.manager.driver(name).user(await roundTrip(instance, { driver: name }));

    Http.assertSent((request) => {
      const data = request.data() as Record<string, string>;

      return (
        request.url === fixture.tokenUrl &&
        request.isForm() &&
        data.grant_type === "authorization_code" &&
        data.code === "the-code"
      );
    });
  });

  it(
    fixture.basicAuth === true
      ? "sends its client credentials as HTTP Basic"
      : "sends its client credentials in the form body",
    async () => {
      const instance = setup(name);

      await instance.manager.driver(name).user(await roundTrip(instance, { driver: name }));

      Http.assertSent((request) => {
        if (request.url !== fixture.tokenUrl) {
          return false;
        }

        const data = request.data() as Record<string, string>;
        const basic = request.header("authorization");

        return fixture.basicAuth === true
          ? // The secret must travel in the header and NOT also in the
            // body: sending it twice is not safer than sending it once.
            basic === `Basic ${Buffer.from(`${name}-id:${name}-secret`).toString("base64")}` &&
              data.client_secret === undefined
          : basic === undefined && data.client_secret === `${name}-secret`;
      });
    },
  );

  if (fixture.requiresPkce === true) {
    it("requires PKCE whatever the config says", async () => {
      const url = new URL(await setup(name).manager.driver(name).redirect(redirectRequest()));

      expect(url.searchParams.get("code_challenge")).not.toBeNull();
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    });
  } else {
    it("leaves PKCE off unless asked", async () => {
      const url = new URL(await setup(name).manager.driver(name).redirect(redirectRequest()));

      expect(url.searchParams.get("code_challenge")).toBeNull();
    });

    it("adds PKCE when configured", async () => {
      harness = createHarness({
        providers: {
          [name]: {
            clientId: "a",
            clientSecret: "b",
            redirect: "https://app.test/cb",
            pkce: true,
            ...PROVIDERS[name].config,
          },
        },
        cookie: { secure: false },
      });

      const url = new URL(await harness.manager.driver(name).redirect(redirectRequest()));

      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    });
  }

  it("replaces its default scopes when config names some", () => {
    harness = createHarness({
      providers: {
        [name]: {
          clientId: "a",
          clientSecret: "b",
          redirect: "https://app.test/cb",
          scopes: ["only:this"],
          ...PROVIDERS[name].config,
        },
      },
      cookie: { secure: false },
    });

    expect(harness.manager.driver(name).getScopes()).toEqual(["only:this"]);
  });

  it("does not mutate the cached driver through a fluent call", () => {
    const instance = setup(name);
    const driver = instance.manager.driver(name);

    driver.scopes(["extra"]).withPkce().stateless().with({ prompt: "consent" });

    expect(instance.manager.driver(name).getScopes()).toEqual(fixture.defaultScopes);
  });
});

describe("the provider table", () => {
  // A driver registered without a fixture is a driver nobody tested, and
  // the tests above are table-driven so it would silently pass.
  it("covers every built-in driver", () => {
    harness = createHarness({ providers: {}, cookie: { secure: false } });

    const registered = new Set<string>();

    // `BUILT_IN` is private, so this probes it the way an app would:
    // configure a provider under each driver name and ask whether it
    // registered.
    for (const name of NAMES) {
      const probe = createHarness(configFor(name));

      if (probe.manager.registered(name)) {
        registered.add(name);
      }

      probe.cleanup();
    }

    expect([...registered].sort()).toEqual([...NAMES].sort());
  });

  it("lists every configured provider as available, with labels", () => {
    const providers: Record<string, SocialiteProviderConfig> = {};

    for (const name of NAMES) {
      providers[name] = {
        clientId: "a",
        clientSecret: "b",
        redirect: "https://app.test/cb",
        ...PROVIDERS[name].config,
      };
    }

    harness = createHarness({ providers, cookie: { secure: false } });

    expect(harness.manager.available()).toEqual(
      NAMES.map((name) => ({ driver: name, ...PROVIDERS[name].meta })),
    );
  });

  it("keeps each provider's state cookie separate", async () => {
    const providers: Record<string, SocialiteProviderConfig> = {};

    for (const name of NAMES) {
      providers[name] = {
        clientId: "a",
        clientSecret: "b",
        redirect: "https://app.test/cb",
        ...PROVIDERS[name].config,
      };
    }

    harness = createHarness({ providers, cookie: { secure: false } });

    const request = redirectRequest();
    const states = new Set<string>();

    for (const name of NAMES) {
      states.add(stateOf(await harness.manager.driver(name).redirect(request)));
    }

    // Nine concurrent flows, nine cookies, nine distinct states — which
    // is what Laravel's flat `state` session key cannot do.
    expect(Object.keys(queuedCookies(request)).sort()).toEqual(
      NAMES.map((name) => `socialite_${name}`).sort(),
    );
    expect(states.size).toBe(NAMES.length);
  });
});
