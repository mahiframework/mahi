import { randomBytes } from "node:crypto";
import { DriverNotRegisteredError } from "@mahiframework/core";
import { afterEach, describe, expect, it } from "vitest";
import { NoDefaultSocialiteDriverError } from "../src/errors.js";
import { GithubSocialiteDriver } from "../src/oauth2/drivers/github-driver.js";
import {
  defaultDriverOptions,
  type Oauth2DriverContext,
} from "../src/oauth2/oauth2-socialite-driver.js";
import { Signer } from "@mahiframework/encryption";
import { createHarness, githubConfig, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

function setup(config = githubConfig()): Harness {
  harness = createHarness(config);

  return harness;
}

afterEach(() => {
  harness?.cleanup();
});

function context(name: string): Oauth2DriverContext {
  return {
    name,
    clientId: "id",
    clientSecret: "secret",
    resolveRedirectUrl: () => "https://app.test/cb",
    signer: new Signer(randomBytes(32)),
    cookie: { secure: false },
  };
}

describe("getDefaultDriver", () => {
  it("throws, because there is no default provider", () => {
    expect(() => setup().manager.getDefaultDriver()).toThrow(NoDefaultSocialiteDriverError);
  });

  it("throws the same from a bare driver() call", () => {
    const { manager } = setup();

    // Without the override this would be a `DriverNotRegisteredError`
    // naming `""`, a driver the app never wrote.
    expect(() => manager.driver()).toThrow(NoDefaultSocialiteDriverError);
  });
});

describe("driver()", () => {
  it("resolves a configured provider", () => {
    expect(setup().manager.driver("github")).toBeInstanceOf(GithubSocialiteDriver);
  });

  it("caches the resolved driver", () => {
    const { manager } = setup();

    expect(manager.driver("github")).toBe(manager.driver("github"));
  });

  it("throws for a name that was never registered", () => {
    expect(() => setup().manager.driver("gitlab")).toThrow(DriverNotRegisteredError);
  });
});

describe("the name-versus-driver split", () => {
  it("treats the config name as the driver name by default", () => {
    expect(setup().manager.driverName("github")).toBe("github");
  });

  it("runs the same driver twice under two names", () => {
    const { manager } = setup(
      githubConfig({
        providers: {
          live: {
            driver: "github",
            clientId: "live-id",
            clientSecret: "live-secret",
            redirect: "https://app.test/live",
          },
          staging: {
            driver: "github",
            clientId: "staging-id",
            clientSecret: "staging-secret",
            redirect: "https://app.test/staging",
          },
        },
      }),
    );

    expect(manager.driverName("live")).toBe("github");
    expect(manager.driver("live")).not.toBe(manager.driver("staging"));
    expect(manager.driver("live")).toBeInstanceOf(GithubSocialiteDriver);
  });

  it("reports undefined for an unconfigured name", () => {
    expect(setup().manager.driverName("nope")).toBeUndefined();
  });
});

describe("registered() and configured()", () => {
  it("reports a configured, recognised provider as both", () => {
    const { manager } = setup();

    expect(manager.configured()).toEqual(["github"]);
    expect(manager.registered("github")).toBe(true);
  });

  it("reports a provider whose driver no package supplies as configured but not registered", () => {
    const { manager } = setup(
      githubConfig({
        providers: {
          acme: {
            driver: "acme-sso",
            clientId: "a",
            clientSecret: "b",
            redirect: "https://app.test/cb",
          },
        },
      }),
    );

    // Skipped rather than rejected, so a driver package's own
    // `extend("acme", ...)` can claim it.
    expect(manager.configured()).toEqual(["acme"]);
    expect(manager.registered("acme")).toBe(false);
  });
});

describe("extend()", () => {
  it("registers a driver the package does not ship", () => {
    const { manager } = setup(
      githubConfig({
        providers: {
          acme: {
            driver: "acme-sso",
            clientId: "a",
            clientSecret: "b",
            redirect: "https://app.test/cb",
          },
        },
      }),
    );

    manager.extend(
      "acme",
      () => new GithubSocialiteDriver(context("acme"), defaultDriverOptions()),
    );

    expect(manager.registered("acme")).toBe(true);
    expect(manager.driver("acme")).toBeInstanceOf(GithubSocialiteDriver);
  });

  it("overrides a built-in, and invalidates what was already resolved", () => {
    const { manager } = setup();
    const builtIn = manager.driver("github");

    manager.extend(
      "github",
      () =>
        new GithubSocialiteDriver(context("github"), defaultDriverOptions({ scopes: ["repo"] })),
    );

    const replaced = manager.driver("github");

    expect(replaced).not.toBe(builtIn);
    expect(replaced.getScopes()).toEqual(["repo"]);
  });
});

describe("available()", () => {
  it("lists configured providers with their labels", () => {
    expect(setup().manager.available()).toEqual([
      { driver: "github", name: "GitHub", website: "https://github.com" },
    ]);
  });

  it("resolves no drivers, so a login page constructs nothing", () => {
    const { manager } = setup();

    manager.available();

    expect(manager.resolvedDriverNames()).toEqual([]);
  });

  it("uses the config name as the driver key, not the driver's own name", () => {
    const { manager } = setup(
      githubConfig({
        providers: {
          work: {
            driver: "github",
            clientId: "a",
            clientSecret: "b",
            redirect: "https://app.test/cb",
          },
        },
      }),
    );

    expect(manager.available()).toEqual([
      { driver: "work", name: "GitHub", website: "https://github.com" },
    ]);
  });

  it("omits a provider whose driver is not registered", () => {
    const { manager } = setup(
      githubConfig({
        providers: {
          acme: {
            driver: "acme-sso",
            clientId: "a",
            clientSecret: "b",
            redirect: "https://app.test/cb",
          },
        },
      }),
    );

    expect(manager.available()).toEqual([]);
  });

  it("is empty when nothing is configured", () => {
    expect(setup({ providers: {} }).manager.available()).toEqual([]);
  });
});

describe("providerConfig()", () => {
  it("returns the configured block", () => {
    expect(setup().manager.providerConfig("github")).toMatchObject({ clientId: "client-id" });
  });

  it("returns undefined for an unknown provider", () => {
    expect(setup().manager.providerConfig("nope")).toBeUndefined();
  });
});
