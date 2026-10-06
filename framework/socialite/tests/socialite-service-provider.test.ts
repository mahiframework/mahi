import { randomBytes } from "node:crypto";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { Signer, SIGNER_TOKEN } from "@mahiframework/encryption";
import { RouteRegistry, URL_GENERATOR_TOKEN, UrlGenerator } from "@mahiframework/http";
import { afterEach, describe, expect, it } from "vitest";
import { MissingDriverConfigError } from "../src/errors.js";
import { Socialite } from "../src/socialite-facade.js";
import { SocialiteManager } from "../src/socialite-manager.js";
import { SocialiteServiceProvider } from "../src/socialite-service-provider.js";
import { SOCIALITE_TOKEN } from "../src/tokens.js";
import type { SocialiteConfig } from "../src/socialite-config.js";
import {
  createHarness,
  githubConfig,
  redirectRequest,
  type Harness,
} from "./__fixtures__/test-app.js";

let harness: Harness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
  Socialite.restore();
  clearCurrentApp();
});

/** A bare app with only the provider's hard dependency bound. */
function app(config: SocialiteConfig): Application {
  const instance = new Application();

  instance.instance(SIGNER_TOKEN, new Signer(randomBytes(32)));
  instance.config.set("socialite", config);
  setCurrentApp(instance);

  return instance;
}

describe("register()", () => {
  it("binds the manager as a singleton", () => {
    const instance = app(githubConfig());
    new SocialiteServiceProvider(instance).register();

    const manager = instance.make<SocialiteManager>(SOCIALITE_TOKEN);

    expect(manager).toBeInstanceOf(SocialiteManager);
    expect(instance.make<SocialiteManager>(SOCIALITE_TOKEN)).toBe(manager);
  });

  it("registers a driver for every recognised provider", () => {
    const instance = app(githubConfig());
    new SocialiteServiceProvider(instance).register();

    expect(instance.make<SocialiteManager>(SOCIALITE_TOKEN).registered("github")).toBe(true);
  });

  it("works with no socialite config at all", () => {
    const instance = new Application();
    instance.instance(SIGNER_TOKEN, new Signer(randomBytes(32)));
    setCurrentApp(instance);

    new SocialiteServiceProvider(instance).register();

    // A manager with no drivers is a perfectly good object, which is the
    // same call `ImageManager` makes.
    expect(instance.make<SocialiteManager>(SOCIALITE_TOKEN).configured()).toEqual([]);
  });

  it("derives a purpose-scoped signer, so another consumer's signature will not verify", async () => {
    const instance = app(githubConfig());
    new SocialiteServiceProvider(instance).register();

    const manager = instance.make<SocialiteManager>(SOCIALITE_TOKEN);
    const request = redirectRequest();

    await manager.driver("github").redirect(request);

    const header = request.queuedCookieHeaders()[0] ?? "";
    const value = decodeURIComponent(header.split(";")[0]?.split("=")[1] ?? "");

    // The root signer must not verify what the "socialite" purpose signed.
    expect(instance.make<Signer>(SIGNER_TOKEN).verify(value)).toBeNull();
    expect(instance.make<Signer>(SIGNER_TOKEN).for("socialite").verify(value)).not.toBeNull();
  });
});

describe("config validation", () => {
  // At registration, not on first resolve: a typo in `.env` should fail
  // at boot rather than when somebody clicks the button. Socialite
  // defers to resolve.
  it.each([
    ["clientId", { clientSecret: "b", redirect: "/cb" }],
    ["clientSecret", { clientId: "a", redirect: "/cb" }],
    ["redirect", { clientId: "a", clientSecret: "b" }],
  ])("rejects a provider missing %s at registration time", (missing, provider) => {
    const instance = app({ providers: { github: provider } });

    expect(() => {
      new SocialiteServiceProvider(instance).register();
      instance.make<SocialiteManager>(SOCIALITE_TOKEN);
    }).toThrow(new RegExp(missing));
  });

  it("lists every missing key at once", () => {
    const instance = app({ providers: { github: {} } });

    let caught: unknown;

    try {
      new SocialiteServiceProvider(instance).register();
      instance.make<SocialiteManager>(SOCIALITE_TOKEN);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MissingDriverConfigError);
    expect((caught as MissingDriverConfigError).missing).toEqual([
      "clientId",
      "clientSecret",
      "redirect",
    ]);
  });

  it("treats an empty string as missing, which is what an unset env var gives", () => {
    const instance = app({
      providers: { github: { clientId: "", clientSecret: "b", redirect: "/cb" } },
    });

    expect(() => {
      new SocialiteServiceProvider(instance).register();
      instance.make<SocialiteManager>(SOCIALITE_TOKEN);
    }).toThrow(MissingDriverConfigError);
  });

  it("ignores an unrecognised driver's config entirely", () => {
    const instance = app({ providers: { acme: { driver: "acme-sso" } } });

    // Not validated, because this package does not own it — the driver
    // package that claims `acme` decides what it needs.
    expect(() => {
      new SocialiteServiceProvider(instance).register();
      instance.make<SocialiteManager>(SOCIALITE_TOKEN);
    }).not.toThrow();
  });
});

describe("the redirect URL", () => {
  it("passes an absolute URL through without needing a URL generator", async () => {
    const instance = app(githubConfig());
    new SocialiteServiceProvider(instance).register();

    const manager = instance.make<SocialiteManager>(SOCIALITE_TOKEN);
    const url = new URL(await manager.driver("github").redirect(redirectRequest()));

    expect(url.searchParams.get("redirect_uri")).toBe("https://app.test/auth/github/callback");
  });

  it("resolves a root-relative URL through the URL generator", async () => {
    const instance = app(
      githubConfig({
        providers: {
          github: {
            clientId: "a",
            clientSecret: "b",
            redirect: "/auth/github/callback",
          },
        },
      }),
    );

    instance.config.set("http", { url: "https://app.test" });
    instance.instance(URL_GENERATOR_TOKEN, new UrlGenerator(instance, new RouteRegistry()));

    new SocialiteServiceProvider(instance).register();

    const manager = instance.make<SocialiteManager>(SOCIALITE_TOKEN);
    const url = new URL(await manager.driver("github").redirect(redirectRequest()));

    // Absolute, and rooted at the generator's base rather than left
    // relative — which is what a provider requires of a `redirect_uri`.
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost/auth/github/callback");
  });

  it("prefers the configured root when there is no active request root", () => {
    const instance = app(
      githubConfig({
        providers: {
          github: { clientId: "a", clientSecret: "b", redirect: "/auth/github/callback" },
        },
      }),
    );

    instance.config.set("http", { url: "https://app.test" });

    const generator = new UrlGenerator(instance, new RouteRegistry());

    expect(generator.to("/auth/github/callback")).toBe("https://app.test/auth/github/callback");
  });

  it("resolves lazily, so the URL generator may be bound after registration", () => {
    const instance = app(
      githubConfig({
        providers: {
          github: { clientId: "a", clientSecret: "b", redirect: "/cb" },
        },
      }),
    );

    // No URL generator bound yet. Registration must still succeed, which
    // is what frees this provider from an ordering constraint.
    expect(() => {
      new SocialiteServiceProvider(instance).register();
      instance.make<SocialiteManager>(SOCIALITE_TOKEN).driver("github");
    }).not.toThrow();
  });
});

describe("the facade", () => {
  it("proxies to the bound manager", () => {
    harness = createHarness();

    expect(Socialite.driver("github").getName()).toBe("GitHub");
    expect(Socialite.available()).toEqual([
      { driver: "github", name: "GitHub", website: "https://github.com" },
    ]);
    expect(Socialite.registered("github")).toBe(true);
    expect(Socialite.configured()).toEqual(["github"]);
  });

  it("can be swapped for a double, and restored", () => {
    harness = createHarness();

    Socialite.swap({ configured: () => ["faked"] });

    expect(Socialite.configured()).toEqual(["faked"]);

    Socialite.restore();

    expect(Socialite.configured()).toEqual(["github"]);
  });
});
