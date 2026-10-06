import { Http } from "@mahiframework/http-client";
import { afterEach, describe, expect, it } from "vitest";
import {
  InvalidStateError,
  MissingAuthorizationCodeError,
  TokenExchangeFailedError,
  UserFetchFailedError,
} from "../src/errors.js";
import { codeChallenge } from "../src/state.js";
import {
  callbackRequest,
  captureError,
  createHarness,
  githubConfig,
  GITHUB_STUBS,
  queuedCookies,
  redirectRequest,
  roundTrip,
  stateOf,
  type Harness,
} from "./__fixtures__/test-app.js";

let harness: Harness;

function setup(config = githubConfig()): Harness {
  harness = createHarness(config);

  return harness;
}

afterEach(() => {
  harness?.cleanup();
});

describe("redirect()", () => {
  it("builds the provider's authorization URL", async () => {
    const driver = setup().manager.driver("github");
    const url = new URL(await driver.redirect(redirectRequest()));

    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.test/auth/github/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("user:email");
  });

  it("queues a state cookie and puts the same state on the URL", async () => {
    const driver = setup().manager.driver("github");
    const request = redirectRequest();

    const state = stateOf(await driver.redirect(request));

    expect(Object.keys(queuedCookies(request))).toEqual(["socialite_github"]);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("adds no PKCE parameters by default", async () => {
    const driver = setup().manager.driver("github");
    const url = new URL(await driver.redirect(redirectRequest()));

    expect(url.searchParams.get("code_challenge")).toBeNull();
    expect(url.searchParams.get("code_challenge_method")).toBeNull();
  });

  it("adds an S256 challenge under withPkce()", async () => {
    const driver = setup().manager.driver("github").withPkce();
    const url = new URL(await driver.redirect(redirectRequest()));

    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("sends extra parameters from with(), last so they can override", async () => {
    const driver = setup()
      .manager.driver("github")
      .with({ prompt: "consent", scope: "overridden" });
    const url = new URL(await driver.redirect(redirectRequest()));

    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe("overridden");
  });

  it("honours a per-call redirectUrl()", async () => {
    const driver = setup().manager.driver("github").redirectUrl("https://other.test/cb");
    const url = new URL(await driver.redirect(redirectRequest()));

    expect(url.searchParams.get("redirect_uri")).toBe("https://other.test/cb");
  });

  it("queues no cookie when stateless", async () => {
    const driver = setup().manager.driver("github").stateless();
    const request = redirectRequest();

    const url = new URL(await driver.redirect(request));

    expect(url.searchParams.get("state")).toBeNull();
    expect(queuedCookies(request)).toEqual({});
  });

  it("still queues a cookie when stateless but using PKCE", async () => {
    const driver = setup().manager.driver("github").stateless().withPkce();
    const request = redirectRequest();

    const url = new URL(await driver.redirect(request));

    // No state to check, but the verifier still has to survive the trip.
    expect(url.searchParams.get("state")).toBeNull();
    expect(url.searchParams.get("code_challenge")).not.toBeNull();
    expect(Object.keys(queuedCookies(request))).toEqual(["socialite_github"]);
  });
});

describe("user()", () => {
  it("exchanges the code and returns a normalised user", async () => {
    const instance = setup();
    const callback = await roundTrip(instance);

    const user = await instance.manager.driver("github").user(callback);

    expect(user.id).toBe("1234");
    expect(user.nickname).toBe("ada");
    expect(user.name).toBe("Ada Lovelace");
    expect(user.email).toBe("ada@example.test");
    expect(user.avatar).toBe("https://avatars.example.test/ada.png");
    expect(user.token.token).toBe("gho_token");
    expect(user.token.approvedScopes).toEqual(["user:email"]);
  });

  it("posts the code as a form-encoded body with the client credentials", async () => {
    const instance = setup();
    const callback = await roundTrip(instance, { code: "the-code" });

    await instance.manager.driver("github").user(callback);

    Http.assertSent((request) => {
      if (!request.url.startsWith("https://github.com/login/oauth/access_token")) {
        return false;
      }

      const data = request.data() as Record<string, string>;

      return (
        request.isForm() &&
        data.code === "the-code" &&
        data.grant_type === "authorization_code" &&
        data.client_id === "client-id" &&
        data.client_secret === "client-secret" &&
        data.redirect_uri === "https://app.test/auth/github/callback"
      );
    });
  });

  it("sends the PKCE verifier, not the challenge, to the token endpoint", async () => {
    const instance = setup();
    const driver = instance.manager.driver("github").withPkce();

    const request = redirectRequest();
    const url = new URL(await driver.redirect(request));
    const callback = callbackRequest(
      { code: "c", state: url.searchParams.get("state") ?? "" },
      queuedCookies(request),
    );

    await driver.user(callback);

    Http.assertSent((sent) => {
      if (!sent.url.startsWith("https://github.com/login/oauth/access_token")) {
        return false;
      }

      const verifier = (sent.data() as Record<string, string>).code_verifier;

      return (
        typeof verifier === "string" &&
        codeChallenge(verifier) === url.searchParams.get("code_challenge")
      );
    });
  });

  it("normalises a numeric provider id to a string", async () => {
    const instance = setup();
    const callback = await roundTrip(instance);

    const user = await instance.manager.driver("github").user(callback);

    expect(user.id).toBe("1234");
    expect(typeof user.id).toBe("string");
  });

  it("exposes the provider's payload as a typed raw", async () => {
    const instance = setup();
    const callback = await roundTrip(instance);

    const user = await instance.manager.driver("github").user(callback);

    expect(user.raw.node_id).toBe("MDQ6VXNlcjEyMzQ=");
  });

  it("reports approvedScopes as [] when the provider omits scope", async () => {
    const instance = setup();
    Http.fake({ ...GITHUB_STUBS, "github.com/login/oauth/access_token": { access_token: "t" } });

    const callback = await roundTrip(instance);
    const user = await instance.manager.driver("github").user(callback);

    // Not `[""]`, which is what a naive `"".split(",")` gives and what
    // Socialite reports.
    expect(user.token.approvedScopes).toEqual([]);
  });

  it("carries a refresh token and expiry when the provider sends them", async () => {
    const instance = setup();
    Http.fake({
      ...GITHUB_STUBS,
      "github.com/login/oauth/access_token": {
        access_token: "t",
        refresh_token: "r",
        expires_in: 28_800,
      },
    });

    const callback = await roundTrip(instance);
    const user = await instance.manager.driver("github").user(callback);

    expect(user.token.refreshToken).toBe("r");
    expect(user.token.expiresIn).toBe(28_800);
  });

  it("reports nulls rather than undefined when the provider sends neither", async () => {
    const instance = setup();
    const callback = await roundTrip(instance);

    const user = await instance.manager.driver("github").user(callback);

    expect(user.token.refreshToken).toBeNull();
    expect(user.token.expiresIn).toBeNull();
  });

  it("accepts a stateless callback with no state at all", async () => {
    const instance = setup();
    const driver = instance.manager.driver("github").stateless();

    const user = await driver.user(callbackRequest({ code: "c" }));

    expect(user.id).toBe("1234");
  });

  it("does not memoise the user across calls on a cached driver", async () => {
    const instance = setup();
    const driver = instance.manager.driver("github");

    const first = await driver.user(await roundTrip(instance));

    Http.fake({
      ...GITHUB_STUBS,
      "api.github.com/user": { ...GITHUB_STUBS["api.github.com/user"], id: 999, login: "grace" },
    });

    const second = await driver.user(await roundTrip(instance));

    // Socialite caches the resolved user on the provider. On a driver
    // cached for the process lifetime that serves one user's profile to
    // the next request.
    expect(first.id).toBe("1234");
    expect(second.id).toBe("999");
    expect(second.nickname).toBe("grace");
  });
});

describe("user() failures", () => {
  it("rejects a callback with no state cookie", async () => {
    const instance = setup();
    const error = await captureError(
      instance.manager.driver("github").user(callbackRequest({ code: "c", state: "forged" })),
    );

    expect(error).toBeInstanceOf(InvalidStateError);
    expect((error as InvalidStateError).reason).toBe("missing");
  });

  it("rejects a callback whose state does not match the cookie", async () => {
    const instance = setup();
    const driver = instance.manager.driver("github");

    const request = redirectRequest();
    await driver.redirect(request);

    const error = await captureError(
      driver.user(callbackRequest({ code: "c", state: "not-it" }, queuedCookies(request))),
    );

    expect((error as InvalidStateError).reason).toBe("mismatch");
  });

  it("rejects a cookie minted by a different provider", async () => {
    const instance = setup(
      githubConfig({
        providers: {
          github: {
            clientId: "a",
            clientSecret: "b",
            redirect: "https://app.test/cb",
          },
          work: {
            driver: "github",
            clientId: "c",
            clientSecret: "d",
            redirect: "https://app.test/cb2",
          },
        },
      }),
    );

    const request = redirectRequest();
    const url = await instance.manager.driver("github").redirect(request);

    // The `work` driver sees `github`'s cookie: a second concurrent flow.
    const callback = callbackRequest(
      { code: "c", state: stateOf(url) },
      { socialite_work: queuedCookies(request).socialite_github ?? "" },
    );

    const error = await captureError(instance.manager.driver("work").user(callback));

    expect((error as InvalidStateError).reason).toBe("wrong-provider");
  });

  it("rejects a replayed callback, because the cookie is single-use", async () => {
    const instance = setup();
    const driver = instance.manager.driver("github");

    const request = redirectRequest();
    const url = await driver.redirect(request);
    const jar = queuedCookies(request);

    const first = callbackRequest({ code: "c", state: stateOf(url) }, jar);
    await driver.user(first);

    // A browser honouring the deletion presents no cookie the second time.
    const replay = callbackRequest({ code: "c", state: stateOf(url) });
    const error = await captureError(driver.user(replay));

    expect((error as InvalidStateError).reason).toBe("missing");
  });

  it("reports the provider's error when the user declined", async () => {
    const instance = setup();
    const driver = instance.manager.driver("github");

    const request = redirectRequest();
    const url = await driver.redirect(request);

    const error = await captureError(
      driver.user(
        callbackRequest(
          {
            state: stateOf(url),
            error: "access_denied",
            error_description: "The user has denied your application access.",
          },
          queuedCookies(request),
        ),
      ),
    );

    expect(error).toBeInstanceOf(MissingAuthorizationCodeError);
    expect((error as MissingAuthorizationCodeError).error).toBe("access_denied");
    expect(String(error)).toContain("denied your application access");
  });

  it("reports a token-endpoint error carried in a 200 body", async () => {
    const instance = setup();
    Http.fake({
      ...GITHUB_STUBS,
      "github.com/login/oauth/access_token": {
        error: "incorrect_client_credentials",
        error_description: "The client_id and/or client_secret passed are incorrect.",
      },
    });

    const callback = await roundTrip(instance);
    const error = await captureError(instance.manager.driver("github").user(callback));

    // GitHub answers a bad secret with a 200 and an error body, which is
    // why the body is checked before the status.
    expect(error).toBeInstanceOf(TokenExchangeFailedError);
    expect((error as TokenExchangeFailedError).error).toBe("incorrect_client_credentials");
  });

  it("reports a token-endpoint failure signalled only by the status", async () => {
    const instance = setup();
    Http.fake({ ...GITHUB_STUBS, "github.com/login/oauth/access_token": Http.response("", 503) });

    const callback = await roundTrip(instance);
    const error = await captureError(instance.manager.driver("github").user(callback));

    expect(error).toBeInstanceOf(TokenExchangeFailedError);
    expect((error as TokenExchangeFailedError).status).toBe(503);
  });

  it("reports a 200 token response that carries no access_token", async () => {
    const instance = setup();
    Http.fake({ ...GITHUB_STUBS, "github.com/login/oauth/access_token": { scope: "user:email" } });

    const callback = await roundTrip(instance);
    const error = await captureError(instance.manager.driver("github").user(callback));

    expect(error).toBeInstanceOf(TokenExchangeFailedError);
    expect(String(error)).toContain("no access_token");
  });

  it("reports a failed user fetch", async () => {
    const instance = setup();
    Http.fake({ ...GITHUB_STUBS, "api.github.com/user": Http.response("", 401) });

    const callback = await roundTrip(instance);
    const error = await captureError(instance.manager.driver("github").user(callback));

    expect(error).toBeInstanceOf(UserFetchFailedError);
    expect((error as UserFetchFailedError).status).toBe(401);
  });
});

describe("copy-on-write fluent methods", () => {
  // The single most important behaviour in the package: `Manager` caches
  // a driver for the process lifetime, so a mutating `scopes()` would
  // silently widen every subsequent login's scopes.
  it("scopes() does not mutate the cached driver", () => {
    const driver = setup().manager.driver("github");

    const widened = driver.scopes(["repo"]);

    expect(driver.getScopes()).toEqual(["user:email"]);
    expect(widened.getScopes()).toEqual(["user:email", "repo"]);
    expect(widened).not.toBe(driver);
  });

  it("re-resolving from the manager returns the same untouched instance", () => {
    const instance = setup();

    instance.manager.driver("github").scopes(["repo"]).with({ prompt: "consent" }).stateless();

    expect(instance.manager.driver("github").getScopes()).toEqual(["user:email"]);
  });

  it("scopes() merges and deduplicates", () => {
    const driver = setup().manager.driver("github");

    expect(driver.scopes(["repo", "user:email", "repo"]).getScopes()).toEqual([
      "user:email",
      "repo",
    ]);
  });

  it("scopes() accepts a single string", () => {
    expect(setup().manager.driver("github").scopes("repo").getScopes()).toEqual([
      "user:email",
      "repo",
    ]);
  });

  it("setScopes() replaces rather than merging", () => {
    const driver = setup().manager.driver("github");

    expect(driver.setScopes(["repo"]).getScopes()).toEqual(["repo"]);
    expect(driver.getScopes()).toEqual(["user:email"]);
  });

  it("chains without accumulating onto the original", async () => {
    const driver = setup().manager.driver("github");

    const configured = driver.scopes(["repo"]).withPkce().with({ prompt: "consent" });
    const url = new URL(await configured.redirect(redirectRequest()));

    expect(url.searchParams.get("scope")).toBe("user:email,repo");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("prompt")).toBe("consent");

    const original = new URL(await driver.redirect(redirectRequest()));

    expect(original.searchParams.get("scope")).toBe("user:email");
    expect(original.searchParams.get("code_challenge_method")).toBeNull();
    expect(original.searchParams.get("prompt")).toBeNull();
  });
});

describe("configured scopes", () => {
  it("replace the driver's defaults rather than merging", () => {
    const instance = setup(
      githubConfig({
        providers: {
          github: {
            clientId: "a",
            clientSecret: "b",
            redirect: "https://app.test/cb",
            scopes: ["repo"],
          },
        },
      }),
    );

    // Socialite merges here, yielding ["user:email", "repo"], which
    // surprises people constantly.
    expect(instance.manager.driver("github").getScopes()).toEqual(["repo"]);
  });

  it("fall back to the driver's defaults when absent", () => {
    expect(setup().manager.driver("github").getScopes()).toEqual(["user:email"]);
  });
});

describe("refreshToken()", () => {
  it("posts a refresh grant and returns fresh credentials", async () => {
    const instance = setup();
    Http.fake({
      "github.com/login/oauth/access_token": {
        access_token: "new-token",
        refresh_token: "new-refresh",
        expires_in: 28_800,
        scope: "user:email",
      },
    });

    const token = await instance.manager.driver("github").refreshToken("old-refresh");

    expect(token).toEqual({
      token: "new-token",
      refreshToken: "new-refresh",
      expiresIn: 28_800,
      approvedScopes: ["user:email"],
    });

    Http.assertSent((request) => {
      const data = request.data() as Record<string, string>;

      return data.grant_type === "refresh_token" && data.refresh_token === "old-refresh";
    });
  });
});

describe("userFromToken()", () => {
  it("fetches a user with no callback and no state", async () => {
    const user = await setup().manager.driver("github").userFromToken("gho_existing");

    expect(user.id).toBe("1234");
    expect(user.token.token).toBe("gho_existing");
  });

  it("carries only the token, because a user endpoint says nothing else", async () => {
    const user = await setup().manager.driver("github").userFromToken("gho_existing");

    expect(user.token.refreshToken).toBeNull();
    expect(user.token.expiresIn).toBeNull();
    expect(user.token.approvedScopes).toEqual([]);
  });

  it("never reaches the token endpoint", async () => {
    await setup().manager.driver("github").userFromToken("gho_existing");

    Http.assertNotSent((request) => request.url.includes("/login/oauth/access_token"));
  });
});

describe("outbound request hygiene", () => {
  it("sends a User-Agent, which GitHub requires", async () => {
    const instance = setup();
    const callback = await roundTrip(instance);

    await instance.manager.driver("github").user(callback);

    Http.assertSent(
      (request) =>
        request.url.startsWith("https://api.github.com/user") &&
        request.header("user-agent") === "Mahi Socialite",
    );
  });

  it("reaches only the provider's own endpoints", async () => {
    const instance = setup();
    const callback = await roundTrip(instance);

    await instance.manager.driver("github").user(callback);

    // `Http.fake()` raises `StrayRequestError` for an unstubbed URL, so
    // an unexpected endpoint would already have failed the test — this
    // pins the exact set, including the second call for the email.
    expect(Http.recorded().map(([request]) => request.url)).toEqual([
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
      "https://api.github.com/user/emails",
    ]);
  });

  // The 10s `timeout()` every call sets is deliberately not asserted
  // here: it is applied as an `AbortSignal` at the real transport
  // boundary, which `Http.fake()` replaces, so there is nothing
  // observable to assert and a test that looked for one would pass
  // whether or not the timeout existed.
});
