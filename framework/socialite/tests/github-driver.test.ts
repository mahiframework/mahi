import { Http } from "@mahiframework/http-client";
import { afterEach, describe, expect, it } from "vitest";
import { GithubSocialiteDriver } from "../src/oauth2/drivers/github-driver.js";
import {
  createHarness,
  githubConfig,
  GITHUB_STUBS,
  redirectRequest,
  roundTrip,
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

describe("metadata", () => {
  it("describes itself statically, so a login page needs no credentials", () => {
    expect(GithubSocialiteDriver.meta).toEqual({
      name: "GitHub",
      website: "https://github.com",
    });
  });

  it("exposes the same metadata on an instance", () => {
    const driver = setup().manager.driver("github");

    expect(driver.getName()).toBe("GitHub");
    expect(driver.getWebsite()).toBe("https://github.com");
  });
});

describe("authentication scheme", () => {
  it("uses GitHub's legacy `token` scheme, not Bearer", async () => {
    const instance = setup();
    const callback = await roundTrip(instance);

    await instance.manager.driver("github").user(callback);

    Http.assertSent(
      (request) =>
        request.url === "https://api.github.com/user" &&
        request.header("authorization") === "token gho_token",
    );
  });

  it("asks for GitHub's v3 media type", async () => {
    const instance = setup();
    const callback = await roundTrip(instance);

    await instance.manager.driver("github").user(callback);

    Http.assertSent(
      (request) =>
        request.url === "https://api.github.com/user" &&
        request.header("accept") === "application/vnd.github.v3+json",
    );
  });
});

describe("scope separator", () => {
  // GitHub genuinely accepts commas where most OAuth 2.0 providers want
  // spaces, so the inherited default is correct here and "fixing" it
  // would be wrong.
  it("joins scopes with a comma", async () => {
    const driver = setup().manager.driver("github").scopes(["repo", "read:org"]);
    const url = new URL(await driver.redirect(redirectRequest()));

    expect(url.searchParams.get("scope")).toBe("user:email,repo,read:org");
  });

  it("splits a comma-separated approved scope list", async () => {
    const instance = setup();
    Http.fake({
      ...GITHUB_STUBS,
      "github.com/login/oauth/access_token": { access_token: "t", scope: "user:email,repo" },
    });

    const user = await instance.manager.driver("github").user(await roundTrip(instance));

    expect(user.token.approvedScopes).toEqual(["user:email", "repo"]);
  });
});

describe("the email call", () => {
  it("returns the primary verified address", async () => {
    const instance = setup();
    const user = await instance.manager.driver("github").user(await roundTrip(instance));

    expect(user.email).toBe("ada@example.test");
  });

  it("is skipped when user:email is not in scope", async () => {
    const instance = setup();
    const driver = instance.manager.driver("github").setScopes(["repo"]);

    const user = await driver.user(await roundTrip(instance));

    Http.assertNotSent((request) => request.url === "https://api.github.com/user/emails");
    expect(user.email).toBeNull();
  });

  it("prefers an email already on the user payload", async () => {
    const instance = setup();
    Http.fake({
      ...GITHUB_STUBS,
      "api.github.com/user": {
        ...GITHUB_STUBS["api.github.com/user"],
        email: "public@example.test",
      },
    });

    const user = await instance.manager.driver("github").user(await roundTrip(instance));

    expect(user.email).toBe("public@example.test");
    Http.assertNotSent((request) => request.url === "https://api.github.com/user/emails");
  });

  it("yields null rather than throwing when the call fails", async () => {
    const instance = setup();
    Http.fake({ ...GITHUB_STUBS, "api.github.com/user/emails": Http.response("", 403) });

    const user = await instance.manager.driver("github").user(await roundTrip(instance));

    // A user whose email is unreadable is still a successfully
    // authenticated user; failing the login over a nullable field is
    // worse. Socialite swallows this too.
    expect(user.email).toBeNull();
    expect(user.id).toBe("1234");
  });

  it("yields null when no address is both primary and verified", async () => {
    const instance = setup();
    Http.fake({
      ...GITHUB_STUBS,
      "api.github.com/user/emails": [
        { email: "unverified@example.test", primary: true, verified: false },
        { email: "secondary@example.test", primary: false, verified: true },
      ],
    });

    const user = await instance.manager.driver("github").user(await roundTrip(instance));

    expect(user.email).toBeNull();
  });

  it("yields null when the response is not a list", async () => {
    const instance = setup();
    Http.fake({ ...GITHUB_STUBS, "api.github.com/user/emails": { message: "Bad credentials" } });

    const user = await instance.manager.driver("github").user(await roundTrip(instance));

    expect(user.email).toBeNull();
  });
});

describe("user mapping", () => {
  it("maps GitHub's field names onto the normalised shape", async () => {
    const instance = setup();
    const user = await instance.manager.driver("github").user(await roundTrip(instance));

    expect(user).toMatchObject({
      id: "1234",
      nickname: "ada",
      name: "Ada Lovelace",
      avatar: "https://avatars.example.test/ada.png",
    });
  });

  it("tolerates an account with no display name", async () => {
    const instance = setup();
    Http.fake({
      ...GITHUB_STUBS,
      "api.github.com/user": { ...GITHUB_STUBS["api.github.com/user"], name: null },
    });

    const user = await instance.manager.driver("github").user(await roundTrip(instance));

    expect(user.name).toBeNull();
    expect(user.nickname).toBe("ada");
  });

  it("keeps the provider's payload reachable on raw", async () => {
    const instance = setup();
    const user = await instance.manager.driver("github").user(await roundTrip(instance));

    expect(user.raw).toMatchObject({ id: 1234, login: "ada", node_id: "MDQ6VXNlcjEyMzQ=" });
  });
});
