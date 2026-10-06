import { Http } from "@mahiframework/http-client";
import { afterEach, describe, expect, it } from "vitest";
import { GoogleSocialiteDriver } from "../src/oauth2/drivers/google-driver.js";
import type { SocialiteConfig } from "../src/socialite-config.js";
import {
  createHarness,
  redirectRequest,
  roundTrip,
  type Harness,
} from "./__fixtures__/test-app.js";

const GOOGLE_STUBS = {
  "oauth2.googleapis.com/token": {
    access_token: "ya29.token",
    refresh_token: "1//refresh",
    expires_in: 3599,
    scope: "openid https://www.googleapis.com/auth/userinfo.email",
  },
  "openidconnect.googleapis.com/v1/userinfo": {
    sub: "110248495921238986420",
    name: "Grace Hopper",
    given_name: "Grace",
    family_name: "Hopper",
    email: "grace@example.test",
    email_verified: true,
    picture: "https://lh3.example.test/grace.png",
  },
};

function googleConfig(overrides: SocialiteConfig = {}): SocialiteConfig {
  return {
    providers: {
      google: {
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
        redirect: "https://app.test/auth/google/callback",
      },
    },
    cookie: { secure: false },
    ...overrides,
  };
}

let harness: Harness;

function setup(config = googleConfig()): Harness {
  harness = createHarness(config);
  Http.fake(GOOGLE_STUBS);

  return harness;
}

afterEach(() => {
  harness?.cleanup();
});

describe("metadata", () => {
  it("describes itself statically", () => {
    expect(GoogleSocialiteDriver.meta).toEqual({
      name: "Google",
      website: "https://google.com",
    });
  });
});

describe("the scope separator", () => {
  // The reason this driver exists in the plan: it is the first one that
  // forces `scopeSeparator` to be a real extension point rather than a
  // constant, because Google rejects GitHub's comma-separated list.
  it("joins scopes with a space, not a comma", async () => {
    const url = new URL(await setup().manager.driver("google").redirect(redirectRequest()));

    expect(url.searchParams.get("scope")).toBe("openid profile email");
  });

  it("splits a space-separated approved scope list", async () => {
    const instance = setup();
    const user = await instance.manager
      .driver("google")
      .user(await roundTrip(instance, { driver: "google" }));

    expect(user.token.approvedScopes).toEqual([
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
    ]);
  });

  it("encodes the space as + in the authorization URL", async () => {
    const url = await setup().manager.driver("google").redirect(redirectRequest());

    // RFC 1738, the inherited default. The round trip through
    // URLSearchParams above proves it decodes correctly either way.
    expect(url).toContain("scope=openid+profile+email");
  });
});

describe("endpoints", () => {
  it("uses the current authorization endpoint", async () => {
    const url = new URL(await setup().manager.driver("google").redirect(redirectRequest()));

    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  });

  it("uses the current token endpoint, not Socialite's dated one", async () => {
    const instance = setup();

    await instance.manager.driver("google").user(await roundTrip(instance, { driver: "google" }));

    Http.assertSent((request) => request.url === "https://oauth2.googleapis.com/token");
    Http.assertNotSent((request) => request.url.includes("googleapis.com/oauth2/v4/token"));
  });

  it("authenticates the userinfo call with Bearer, the base's default", async () => {
    const instance = setup();

    await instance.manager.driver("google").user(await roundTrip(instance, { driver: "google" }));

    Http.assertSent(
      (request) =>
        request.url === "https://openidconnect.googleapis.com/v1/userinfo" &&
        request.header("authorization") === "Bearer ya29.token",
    );
  });
});

describe("user mapping", () => {
  it("maps OIDC claims onto the normalised shape", async () => {
    const instance = setup();
    const user = await instance.manager
      .driver("google")
      .user(await roundTrip(instance, { driver: "google" }));

    expect(user).toMatchObject({
      id: "110248495921238986420",
      name: "Grace Hopper",
      email: "grace@example.test",
      avatar: "https://lh3.example.test/grace.png",
    });
  });

  it("falls back to given_name for a nickname, which Google rarely sends", async () => {
    const instance = setup();
    const user = await instance.manager
      .driver("google")
      .user(await roundTrip(instance, { driver: "google" }));

    expect(user.nickname).toBe("Grace");
  });

  it("prefers an explicit nickname when one is present", async () => {
    const instance = setup();
    Http.fake({
      ...GOOGLE_STUBS,
      "openidconnect.googleapis.com/v1/userinfo": {
        ...GOOGLE_STUBS["openidconnect.googleapis.com/v1/userinfo"],
        nickname: "amazing-grace",
      },
    });

    const user = await instance.manager
      .driver("google")
      .user(await roundTrip(instance, { driver: "google" }));

    expect(user.nickname).toBe("amazing-grace");
  });

  it("tolerates a payload carrying only sub, which is all that is guaranteed", async () => {
    const instance = setup();
    Http.fake({
      ...GOOGLE_STUBS,
      "openidconnect.googleapis.com/v1/userinfo": { sub: "42" },
    });

    const user = await instance.manager
      .driver("google")
      .user(await roundTrip(instance, { driver: "google" }));

    expect(user).toMatchObject({
      id: "42",
      name: null,
      email: null,
      avatar: null,
      nickname: null,
    });
  });

  it("keeps the claims reachable on raw", async () => {
    const instance = setup();
    const user = await instance.manager
      .driver("google")
      .user(await roundTrip(instance, { driver: "google" }));

    expect(user.raw.email_verified).toBe(true);
    expect(user.raw.family_name).toBe("Hopper");
  });
});

describe("refreshToken()", () => {
  // The second reason this driver exists: Google issues `refresh_token`
  // only on the first authorization, so a refresh that reported null
  // would cost the caller the ability to refresh again.
  it("carries the old refresh token forward when Google omits a new one", async () => {
    const instance = setup();
    Http.fake({
      "oauth2.googleapis.com/token": {
        access_token: "ya29.fresh",
        expires_in: 3599,
        scope: "openid email",
      },
    });

    const token = await instance.manager.driver("google").refreshToken("1//original");

    expect(token).toEqual({
      token: "ya29.fresh",
      refreshToken: "1//original",
      expiresIn: 3599,
      approvedScopes: ["openid", "email"],
    });
  });

  it("uses a new refresh token when Google does send one", async () => {
    const instance = setup();
    Http.fake({
      "oauth2.googleapis.com/token": {
        access_token: "ya29.fresh",
        refresh_token: "1//rotated",
        expires_in: 3599,
      },
    });

    const token = await instance.manager.driver("google").refreshToken("1//original");

    expect(token.refreshToken).toBe("1//rotated");
  });

  it("posts a refresh grant", async () => {
    const instance = setup();

    await instance.manager.driver("google").refreshToken("1//original");

    Http.assertSent((request) => {
      const data = request.data() as Record<string, string>;

      return (
        request.url === "https://oauth2.googleapis.com/token" &&
        data.grant_type === "refresh_token" &&
        data.refresh_token === "1//original" &&
        data.client_id === "google-client-id"
      );
    });
  });
});

describe("offline access", () => {
  it("is requested through with(), which Google needs for a refresh token", async () => {
    const driver = setup()
      .manager.driver("google")
      .with({ access_type: "offline", prompt: "consent" });

    const url = new URL(await driver.redirect(redirectRequest()));

    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });
});

describe("two drivers coexist", () => {
  it("keeps each provider's state cookie separate", async () => {
    harness = createHarness({
      providers: {
        github: {
          clientId: "gh",
          clientSecret: "gh-secret",
          redirect: "https://app.test/gh",
        },
        google: {
          clientId: "gg",
          clientSecret: "gg-secret",
          redirect: "https://app.test/gg",
        },
      },
      cookie: { secure: false },
    });

    const request = redirectRequest();

    await harness.manager.driver("github").redirect(request);
    await harness.manager.driver("google").redirect(request);

    const names = request.queuedCookieHeaders().map((header) => header.split("=")[0]);

    expect(names.sort()).toEqual(["socialite_github", "socialite_google"]);
  });

  it("lists both as available, each with its own label", () => {
    harness = createHarness({
      providers: {
        github: { clientId: "a", clientSecret: "b", redirect: "https://app.test/gh" },
        google: { clientId: "c", clientSecret: "d", redirect: "https://app.test/gg" },
      },
      cookie: { secure: false },
    });

    expect(harness.manager.available()).toEqual([
      { driver: "github", name: "GitHub", website: "https://github.com" },
      { driver: "google", name: "Google", website: "https://google.com" },
    ]);
  });
});
