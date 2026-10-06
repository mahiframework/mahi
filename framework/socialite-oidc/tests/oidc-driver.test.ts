import { Http } from "@mahiframework/http-client";
import { generateSecret } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DiscoveryFailedError, IdTokenInvalidError, SubjectMismatchError } from "../src/errors.js";
import {
  callbackRequest,
  captureError,
  CLIENT_ID,
  createHarness,
  createKeys,
  fakeIssuer,
  ISSUER,
  oidcConfig,
  queuedCookies,
  redirectRequest,
  roundTrip,
  type Harness,
  type Keys,
} from "./__fixtures__/test-app.js";

let harness: Harness;
let keys: Keys;

beforeAll(async () => {
  // One key pair for the suite: RSA generation is slow and the key is
  // not what any case is varying.
  keys = await createKeys();
});

async function setup(config = oidcConfig()): Promise<Harness> {
  harness = await createHarness(config, keys);

  return harness;
}

afterEach(() => {
  harness?.cleanup();
});

/** Assert an `IdTokenInvalidError` with a specific reason. */
async function expectReason(
  operation: Promise<unknown>,
  reason: IdTokenInvalidError["reason"],
): Promise<void> {
  const error = await captureError(operation);

  expect(error).toBeInstanceOf(IdTokenInvalidError);
  expect((error as IdTokenInvalidError).reason).toBe(reason);
}

describe("discovery", () => {
  it("resolves endpoints from the issuer's metadata", async () => {
    const instance = await setup();
    fakeIssuer({ keys });

    const url = new URL(await instance.manager.driver("work").redirect(redirectRequest()));

    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/protocol/openid-connect/auth`);
    Http.assertSent((request) => request.url.endsWith("/.well-known/openid-configuration"));
  });

  it("caches the document, so a second flow makes no discovery call", async () => {
    const instance = await setup();
    fakeIssuer({ keys });

    const driver = instance.manager.driver("work");

    await driver.redirect(redirectRequest());
    await driver.redirect(redirectRequest());

    const discoveries = Http.recorded().filter(([request]) =>
      request.url.endsWith("/.well-known/openid-configuration"),
    );

    // `Kovah`'s package refetches on every redirect and every callback,
    // making the IdP a hard latency dependency of each login.
    expect(discoveries).toHaveLength(1);
  });

  it("shares the cache with a fluent copy", async () => {
    const instance = await setup();
    fakeIssuer({ keys });

    const driver = instance.manager.driver("work");

    await driver.redirect(redirectRequest());
    await driver.scopes(["extra"]).redirect(redirectRequest());

    expect(
      Http.recorded().filter(([request]) =>
        request.url.endsWith("/.well-known/openid-configuration"),
      ),
    ).toHaveLength(1);
  });

  it("rejects a document declaring a different issuer", async () => {
    const instance = await setup();
    fakeIssuer({ keys, discovery: { issuer: "https://evil.test" } });

    const error = await captureError(instance.manager.driver("work").redirect(redirectRequest()));

    // Without this check a substituted document redirects the
    // authorization, token and JWKS endpoints anywhere it likes.
    expect(error).toBeInstanceOf(DiscoveryFailedError);
    expect(String(error)).toContain("not the configured issuer");
  });

  it("tolerates a trailing-slash difference in the issuer", async () => {
    const instance = await setup();
    fakeIssuer({ keys, discovery: { issuer: `${ISSUER}/` } });

    await expect(instance.manager.driver("work").redirect(redirectRequest())).resolves.toContain(
      "/protocol/openid-connect/auth",
    );
  });

  it("rejects a document missing a required endpoint", async () => {
    const instance = await setup();
    Http.fake({
      "idp.test/realms/main/.well-known/openid-configuration": {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/auth`,
      },
    });

    const error = await captureError(instance.manager.driver("work").redirect(redirectRequest()));

    expect(error).toBeInstanceOf(DiscoveryFailedError);
    expect(String(error)).toContain("token_endpoint");
  });

  it("reports an unreachable issuer", async () => {
    const instance = await setup();
    Http.fake({
      "idp.test/realms/main/.well-known/openid-configuration": Http.response("", 503),
    });

    const error = await captureError(instance.manager.driver("work").redirect(redirectRequest()));

    expect(error).toBeInstanceOf(DiscoveryFailedError);
    expect(String(error)).toContain("HTTP 503");
  });
});

describe("the authorization request", () => {
  it("sends a nonce, which plain OAuth 2.0 does not", async () => {
    const instance = await setup();
    fakeIssuer({ keys });

    const url = new URL(await instance.manager.driver("work").redirect(redirectRequest()));

    expect(url.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("sends a different nonce every time", async () => {
    const instance = await setup();
    fakeIssuer({ keys });

    const driver = instance.manager.driver("work");
    const first = new URL(await driver.redirect(redirectRequest()));
    const second = new URL(await driver.redirect(redirectRequest()));

    expect(first.searchParams.get("nonce")).not.toBe(second.searchParams.get("nonce"));
  });

  it("requires PKCE, because OAuth 2.1 and FAPI do", async () => {
    const instance = await setup();
    fakeIssuer({ keys });

    const url = new URL(await instance.manager.driver("work").redirect(redirectRequest()));

    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).not.toBeNull();
  });

  it("requests the openid scope, without which there is no id_token", async () => {
    const instance = await setup();

    expect(instance.manager.driver("work").getScopes()).toEqual(["openid", "profile", "email"]);
  });

  it("joins scopes with a space", async () => {
    const instance = await setup();
    fakeIssuer({ keys });

    const url = new URL(await instance.manager.driver("work").redirect(redirectRequest()));

    expect(url.searchParams.get("scope")).toBe("openid profile email");
  });
});

describe("a valid callback", () => {
  it("resolves a user from the verified id_token and userinfo", async () => {
    const instance = await setup();
    const callback = await roundTrip(instance);

    const user = await instance.manager.driver("work").user(callback);

    expect(user).toMatchObject({
      id: "f:1234:ada",
      nickname: "ada",
      name: "Ada Lovelace",
      email: "ada@example.test",
      avatar: "https://idp.test/ada.png",
    });
  });

  it("prefers preferred_username for the nickname", async () => {
    const instance = await setup();
    const callback = await roundTrip(instance, {
      userinfo: { sub: "f:1234:ada", preferred_username: "ada.l", nickname: "ignored" },
    });

    // Keycloak, Authentik and Entra ID all send `preferred_username` and
    // rarely send `nickname`; `Kovah`'s package maps only the latter.
    expect((await instance.manager.driver("work").user(callback)).nickname).toBe("ada.l");
  });

  it("falls back to nickname when there is no preferred_username", async () => {
    const instance = await setup();
    const callback = await roundTrip(instance, {
      // Cleared on both sources: the id_token carries it too, and
      // userinfo claims merge over the token's.
      claims: { preferred_username: undefined },
      userinfo: { sub: "f:1234:ada", nickname: "ada-nick" },
    });

    expect((await instance.manager.driver("work").user(callback)).nickname).toBe("ada-nick");
  });

  it("fetches userinfo with a Bearer header, not a query parameter", async () => {
    const instance = await setup();
    const callback = await roundTrip(instance);

    await instance.manager.driver("work").user(callback);

    // RFC 6750 §2.3 discourages the query form, and Okta and Entra ID
    // reject it. `Kovah`'s package uses it.
    Http.assertSent(
      (request) =>
        request.url === `${ISSUER}/protocol/openid-connect/userinfo` &&
        request.header("authorization") === "Bearer at" &&
        !request.url.includes("access_token="),
    );
  });

  it("takes identity from the id_token alone when idTokenOnly is set", async () => {
    const instance = await setup(oidcConfig({ idTokenOnly: true }));
    const callback = await roundTrip(instance);

    const user = await instance.manager.driver("work").user(callback);

    expect(user.id).toBe("f:1234:ada");
    Http.assertNotSent((request) => request.url.endsWith("/userinfo"));
  });

  it("clears the state cookie, so a replayed callback fails", async () => {
    const instance = await setup();
    const callback = await roundTrip(instance);
    const driver = instance.manager.driver("work");

    await driver.user(callback);

    expect(queuedCookies(callback).socialite_work).toBeUndefined();
  });
});

describe("id_token validation", () => {
  it("rejects a token response carrying no id_token", async () => {
    const instance = await setup();
    fakeIssuer({ keys });

    const driver = instance.manager.driver("work");
    const redirect = redirectRequest();
    const url = new URL(await driver.redirect(redirect));

    // Re-stub without an `id_token`.
    fakeIssuer({ keys });

    const callback = callbackRequest(
      { code: "c", state: url.searchParams.get("state") ?? "" },
      queuedCookies(redirect),
    );

    await expectReason(driver.user(callback), "missing");
  });

  it("rejects a token signed with the wrong key", async () => {
    const instance = await setup();
    const other = await createKeys();

    // Signed by a key the issuer's JWKS does not publish.
    const callback = await roundTrip(instance, { key: other.privateKey });

    await expectReason(instance.manager.driver("work").user(callback), "signature");
  });

  it("rejects alg: none", async () => {
    const instance = await setup();
    fakeIssuer({ keys });

    const driver = instance.manager.driver("work");
    const redirect = redirectRequest();
    const url = new URL(await driver.redirect(redirect));

    // Hand-crafted, because `jose` refuses to *mint* an unsecured JWT —
    // which is itself reassuring, but means the attack has to be
    // assembled by hand to prove the verifier rejects it.
    const unsecured = `${base64url({ alg: "none", kid: keys.kid })}.${base64url({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: "f:1234:eve",
      nonce: url.searchParams.get("nonce"),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    })}.`;

    fakeIssuer({ keys, idToken: unsecured });

    const callback = callbackRequest(
      { code: "c", state: url.searchParams.get("state") ?? "" },
      queuedCookies(redirect),
    );

    await expectReason(driver.user(callback), "algorithm");
  });

  it("rejects an HS256 token signed with the issuer's public key", async () => {
    const instance = await setup();
    const secret = await generateSecret("HS256", { extractable: true });

    // The classic algorithm-confusion attack: the "public" key is
    // public, so if the verifier lets the token choose HS256 the
    // attacker can mint whatever they like.
    const callback = await roundTrip(instance, { alg: "HS256", key: secret });

    await expectReason(instance.manager.driver("work").user(callback), "algorithm");
  });

  it("rejects a token from a different issuer", async () => {
    const instance = await setup();
    const callback = await roundTrip(instance, { claims: { iss: "https://evil.test" } });

    await expectReason(instance.manager.driver("work").user(callback), "issuer");
  });

  it("rejects a token minted for a different client", async () => {
    const instance = await setup();
    const callback = await roundTrip(instance, { claims: { aud: "someone-else" } });

    await expectReason(instance.manager.driver("work").user(callback), "audience");
  });

  it("rejects a multi-valued aud with no matching azp", async () => {
    const instance = await setup();
    const callback = await roundTrip(instance, {
      claims: { aud: [CLIENT_ID, "other-client"], azp: "other-client" },
    });

    // OIDC Core §3.1.3.7 step 4. `jose` checks membership but not this,
    // so without the explicit check a token shared across clients is
    // accepted by all of them.
    await expectReason(instance.manager.driver("work").user(callback), "audience");
  });

  it("accepts a multi-valued aud whose azp is this client", async () => {
    const instance = await setup();
    const callback = await roundTrip(instance, {
      claims: { aud: [CLIENT_ID, "other-client"], azp: CLIENT_ID },
    });

    await expect(instance.manager.driver("work").user(callback)).resolves.toMatchObject({
      id: "f:1234:ada",
    });
  });

  it("rejects an expired token", async () => {
    const instance = await setup();
    const past = Math.floor(Date.now() / 1000) - 3600;
    const callback = await roundTrip(instance, { claims: { iat: past, exp: past + 60 } });

    await expectReason(instance.manager.driver("work").user(callback), "expired");
  });

  it("rejects a token that is not yet valid", async () => {
    const instance = await setup();
    const future = Math.floor(Date.now() / 1000) + 3600;
    const callback = await roundTrip(instance, { claims: { nbf: future } });

    await expectReason(instance.manager.driver("work").user(callback), "expired");
  });

  it("allows a small clock skew", async () => {
    const instance = await setup();
    const now = Math.floor(Date.now() / 1000);

    // Thirty seconds past, inside the default sixty-second tolerance.
    const callback = await roundTrip(instance, { claims: { exp: now - 30 } });

    await expect(instance.manager.driver("work").user(callback)).resolves.toMatchObject({
      id: "f:1234:ada",
    });
  });

  it("rejects a token whose nonce does not match", async () => {
    const instance = await setup();
    const callback = await roundTrip(instance, { nonce: "not-the-issued-nonce" });

    await expectReason(instance.manager.driver("work").user(callback), "nonce");
  });

  it("rejects a token carrying no nonce at all", async () => {
    const instance = await setup();
    const callback = await roundTrip(instance, { nonce: null });

    // The replay defence. `state` is CSRF protection and is not a
    // substitute — Socialite's base provider has no nonce support.
    await expectReason(instance.manager.driver("work").user(callback), "nonce");
  });

  it("rejects a malformed token", async () => {
    const instance = await setup();
    fakeIssuer({ keys });

    const driver = instance.manager.driver("work");
    const redirect = redirectRequest();
    const url = new URL(await driver.redirect(redirect));

    fakeIssuer({ keys, idToken: "not-a-jwt" });

    const callback = callbackRequest(
      { code: "c", state: url.searchParams.get("state") ?? "" },
      queuedCookies(redirect),
    );

    await expectReason(driver.user(callback), "malformed");
  });

  it("honours a configured algorithm allow-list", async () => {
    const instance = await setup(oidcConfig({ algorithms: ["ES256"] }));
    const callback = await roundTrip(instance);

    // A perfectly valid RS256 token, refused because this deployment
    // said ES256 only.
    await expectReason(instance.manager.driver("work").user(callback), "algorithm");
  });
});

describe("the userinfo subject check", () => {
  it("rejects a userinfo sub that disagrees with the id_token", async () => {
    const instance = await setup();
    const callback = await roundTrip(instance, {
      userinfo: { sub: "f:9999:eve", name: "Eve" },
    });

    // OIDC Core §5.3.2. Without it one user's token pairs with
    // another's profile — and the profile is what an app keys on.
    const error = await captureError(instance.manager.driver("work").user(callback));

    expect(error).toBeInstanceOf(SubjectMismatchError);
    expect(String(error)).toContain("f:9999:eve");
  });

  it("rejects userinfo carrying no sub", async () => {
    const instance = await setup();
    const callback = await roundTrip(instance, { userinfo: { name: "Ada" } });

    await expectReason(instance.manager.driver("work").user(callback), "claims");
  });

  it("keeps the id_token sub as the identity", async () => {
    const instance = await setup();
    const callback = await roundTrip(instance);

    const user = await instance.manager.driver("work").user(callback);

    expect(user.id).toBe("f:1234:ada");
    expect(user.raw.sub).toBe("f:1234:ada");
  });
});

describe("JWKS handling", () => {
  it("fetches the key set once and caches it", async () => {
    const instance = await setup();
    const driver = instance.manager.driver("work");

    // Each flow restubs, which resets the recording — so the count is
    // taken per flow and both must be the same shape: one fetch on the
    // first, none on the second.
    await driver.user(await roundTrip(instance));
    const first = certsFetches();

    await driver.user(await roundTrip(instance));
    const second = certsFetches();

    // The resolver's cache lives on the object, so building one per call
    // would defeat it and hammer the IdP.
    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  it("refetches when it sees an unknown kid, so key rotation self-heals", async () => {
    // Zero cooldown, because the rate limit is the thing being stood
    // down here, not the thing under test: with the default 30s a
    // rotation inside the same test would correctly refuse to refetch.
    const instance = await setup(oidcConfig({ jwksCooldownSeconds: 0 }));
    const driver = instance.manager.driver("work");

    // Warm the cache with the original key set.
    await driver.user(await roundTrip(instance));

    // The issuer rotates: a new key, a new kid, and the cached JWKS no
    // longer contains the signing key. `cooldownDuration` is what makes
    // this recover in seconds; a flat TTL (Kovah's one hour) would fail
    // every login until it expired.
    // The old key is retired, so the cached set contains no key matching
    // the new `kid` — which is what drives `jose` to refetch. Serving
    // both keys would find a match in the cache and correctly refetch
    // nothing, so this test would then prove nothing.
    const rotated = await createKeys("rotated-key");
    const callback = await roundTrip(instance, {
      signWith: rotated,
      jwks: { keys: [rotated.jwk] },
    });

    await expect(driver.user(callback)).resolves.toMatchObject({ id: "f:1234:ada" });

    // One fetch in this flow's recording, i.e. the unknown `kid` drove a
    // refetch rather than failing against the stale set.
    expect(certsFetches()).toBe(1);
  });

  it("rate-limits the refetch, so a bogus kid cannot amplify against the issuer", async () => {
    const instance = await setup();
    const driver = instance.manager.driver("work");

    await driver.user(await roundTrip(instance));

    // Same rotation, but at the default 30s cooldown: the refetch is
    // withheld and the login fails rather than hammering the IdP. That
    // is the correct trade, and it is why the cooldown is configurable.
    const rotated = await createKeys("rotated-key");
    const callback = await roundTrip(instance, {
      signWith: rotated,
      jwks: { keys: [rotated.jwk] },
    });

    // `jose` keys its refetch on "no matching key", so a withheld
    // refetch surfaces as that rather than a signature failure.
    await expectReason(driver.user(callback), "signature");
    expect(certsFetches()).toBe(0);
  });

  it("does not refetch when the cached set still has a matching key", async () => {
    const instance = await setup(oidcConfig({ jwksCooldownSeconds: 0 }));
    const driver = instance.manager.driver("work");

    await driver.user(await roundTrip(instance));

    // A second key is published but the original still signs, so the
    // cached set matches and no refetch is warranted. `jose` keys the
    // refetch on "no matching key", not on the set having changed.
    const extra = await createKeys("extra-key");
    const callback = await roundTrip(instance, { jwks: { keys: [keys.jwk, extra.jwk] } });

    await expect(driver.user(callback)).resolves.toMatchObject({ id: "f:1234:ada" });
    expect(certsFetches()).toBe(0);
  });
});

/** How many JWKS fetches the current stub has recorded. */
function certsFetches(): number {
  return Http.recorded().filter(([request]) => request.url.endsWith("/certs")).length;
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("metadata and logout", () => {
  it("labels itself from config, falling back to the issuer host", async () => {
    const labelled = await setup();

    expect(labelled.manager.driver("work").getName()).toBe("Work SSO");
    expect(labelled.manager.driver("work").getWebsite()).toBe(ISSUER);

    labelled.cleanup();

    const unlabelled = await setup(oidcConfig({ label: undefined }));

    expect(unlabelled.manager.driver("work").getName()).toBe("idp.test");
  });

  it("builds an RP-initiated logout URL", async () => {
    const instance = await setup();
    fakeIssuer({ keys });

    const driver = instance.manager.driver("work");
    const url = await (
      driver as unknown as {
        logoutUrl(options: { idToken?: string; redirectTo?: string }): Promise<string | null>;
      }
    ).logoutUrl({ idToken: "the-id-token", redirectTo: "https://app.test/goodbye" });

    expect(url).not.toBeNull();

    const parsed = new URL(url as string);

    expect(parsed.searchParams.get("id_token_hint")).toBe("the-id-token");
    expect(parsed.searchParams.get("post_logout_redirect_uri")).toBe("https://app.test/goodbye");
    expect(parsed.searchParams.get("client_id")).toBe(CLIENT_ID);
  });

  it("returns null when the issuer advertises no end_session_endpoint", async () => {
    const instance = await setup();
    fakeIssuer({ keys, discovery: { end_session_endpoint: undefined } });

    const driver = instance.manager.driver("work");
    const url = await (driver as unknown as { logoutUrl(): Promise<string | null> }).logoutUrl();

    expect(url).toBeNull();
  });
});

describe("registration", () => {
  it("claims only providers whose driver is oidc", async () => {
    const instance = await setup({
      providers: {
        work: {
          driver: "oidc",
          issuer: ISSUER,
          clientId: CLIENT_ID,
          clientSecret: "s",
          redirect: "https://app.test/cb",
        },
        github: { clientId: "a", clientSecret: "b", redirect: "https://app.test/gh" },
      },
      cookie: { secure: false },
    });

    expect(instance.manager.registered("work")).toBe(true);
    expect(instance.manager.registered("github")).toBe(true);
    expect(instance.manager.driver("github").getName()).toBe("GitHub");
    expect(instance.manager.driver("work").getName()).toBe("idp.test");
  });

  it("rejects an oidc provider with no issuer, at boot", async () => {
    const error = await captureError(
      createHarness(
        {
          providers: {
            work: {
              driver: "oidc",
              clientId: CLIENT_ID,
              clientSecret: "s",
              redirect: "https://app.test/cb",
            },
          },
        },
        keys,
      ),
    );

    expect(String(error)).toContain("issuer");
  });

  it("makes no network call until a driver is used", async () => {
    await setup();
    Http.fake({});

    expect(Http.recorded()).toHaveLength(0);
  });
});

describe("userFromToken", () => {
  it("resolves from userinfo, since there is no id_token to verify", async () => {
    const instance = await setup();
    fakeIssuer({ keys });

    const user = await instance.manager.driver("work").userFromToken("existing-at");

    expect(user.id).toBe("f:1234:ada");
    expect(user.token.token).toBe("existing-at");
  });

  it("mints an id_token token for nobody, so no nonce is required", async () => {
    const instance = await setup();
    fakeIssuer({ keys });

    await expect(
      instance.manager.driver("work").userFromToken("existing-at"),
    ).resolves.toBeDefined();
  });
});
