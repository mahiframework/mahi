import { randomBytes } from "node:crypto";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { Signer, SIGNER_TOKEN } from "@mahiframework/encryption";
import { Request } from "@mahiframework/http";
import { Http } from "@mahiframework/http-client";
import {
  SocialiteServiceProvider,
  SOCIALITE_TOKEN,
  type SocialiteConfig,
  type SocialiteManager,
} from "@mahiframework/socialite";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
  type KeyObject,
} from "jose";
import { SocialiteOidcServiceProvider } from "../../src/socialite-oidc-service-provider.js";

export const ISSUER = "https://idp.test/realms/main";
export const CLIENT_ID = "mahi-app";

export interface Keys {
  privateKey: KeyObject | CryptoKey;
  jwk: JWK;
  kid: string;
}

/** An RS256 key pair, with its public half as a JWKS-ready JWK. */
export async function createKeys(kid = "test-key"): Promise<Keys> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);

  return { privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" }, kid };
}

/** The discovery document an issuer would serve. */
export function discoveryDocument(overrides: Record<string, unknown> = {}) {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
    token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
    userinfo_endpoint: `${ISSUER}/protocol/openid-connect/userinfo`,
    jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
    end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
    id_token_signing_alg_values_supported: ["RS256"],
    ...overrides,
  };
}

export interface IdTokenClaims {
  iss?: string;
  aud?: string | string[];
  azp?: string;
  sub?: string;
  nonce?: string | null;
  exp?: number;
  iat?: number;
  nbf?: number;
  name?: string;
  email?: string;
  preferred_username?: string;
  picture?: string;
}

/** Mint an `id_token`. Every negative case is a real signed JWT. */
export async function mintIdToken(
  keys: Keys,
  claims: IdTokenClaims = {},
  options: { alg?: string; key?: KeyObject | CryptoKey | Uint8Array } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const { nonce, ...rest } = claims;

  const payload: Record<string, unknown> = {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: "f:1234:ada",
    iat: now,
    exp: now + 300,
    name: "Ada Lovelace",
    email: "ada@example.test",
    preferred_username: "ada",
    picture: "https://idp.test/ada.png",
    ...rest,
  };

  if (nonce !== null) {
    payload.nonce = nonce;
  }

  return new SignJWT(payload)
    .setProtectedHeader({ alg: options.alg ?? "RS256", kid: keys.kid })
    .sign(options.key ?? keys.privateKey);
}

export interface Harness {
  app: Application;
  manager: SocialiteManager;
  signer: Signer;
  keys: Keys;
  cleanup: () => void;
}

export function oidcConfig(overrides: Record<string, unknown> = {}): SocialiteConfig {
  return {
    providers: {
      work: {
        driver: "oidc",
        issuer: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: "app-secret",
        redirect: "https://app.test/auth/work/callback",
        label: "Work SSO",
        ...overrides,
      },
    },
    cookie: { secure: false },
  };
}

/**
 * An application with both providers registered.
 *
 * Framework-package style, no `@mahiframework/testing` dependency. The
 * OIDC provider registers in `boot()`, so it is run explicitly here —
 * which also proves the order-independence it claims.
 */
export async function createHarness(config = oidcConfig(), keys?: Keys): Promise<Harness> {
  const app = new Application();
  const signer = new Signer(randomBytes(32));
  const resolved = keys ?? (await createKeys());

  app.instance(SIGNER_TOKEN, signer);
  setCurrentApp(app);
  app.config.set("socialite", config);

  new SocialiteServiceProvider(app).register();
  new SocialiteOidcServiceProvider(app).boot();

  return {
    app,
    manager: app.make<SocialiteManager>(SOCIALITE_TOKEN),
    signer,
    keys: resolved,
    cleanup: () => {
      Http.restore();
      clearCurrentApp();
    },
  };
}

/** Stub discovery, JWKS, token and userinfo for a full round trip. */
export function fakeIssuer(options: {
  keys: Keys;
  idToken?: string;
  discovery?: Record<string, unknown>;
  userinfo?: Record<string, unknown>;
  jwks?: { keys: JWK[] };
}): void {
  Http.fake({
    "idp.test/realms/main/.well-known/openid-configuration": discoveryDocument(
      options.discovery ?? {},
    ),
    "idp.test/realms/main/protocol/openid-connect/certs": options.jwks ?? {
      keys: [options.keys.jwk],
    },
    "idp.test/realms/main/protocol/openid-connect/token": {
      access_token: "at",
      token_type: "Bearer",
      expires_in: 300,
      scope: "openid profile email",
      ...(options.idToken === undefined ? {} : { id_token: options.idToken }),
    },
    "idp.test/realms/main/protocol/openid-connect/userinfo": options.userinfo ?? {
      sub: "f:1234:ada",
      name: "Ada Lovelace",
      email: "ada@example.test",
      preferred_username: "ada",
      picture: "https://idp.test/ada.png",
    },
  });
}

export function redirectRequest(): Request {
  return Request.create("/auth/work/redirect");
}

export function callbackRequest(
  query: Record<string, string> = {},
  cookies: Record<string, string> = {},
): Request {
  const headers: Record<string, string> = {};
  const entries = Object.entries(cookies);

  if (entries.length > 0) {
    headers.cookie = entries
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join("; ");
  }

  return Request.create("/auth/work/callback", "GET", {}, { query, headers });
}

export function queuedCookies(request: Request): Record<string, string> {
  const jar: Record<string, string> = {};

  for (const header of request.queuedCookieHeaders()) {
    const [pair] = header.split(";");
    const index = pair?.indexOf("=") ?? -1;

    if (pair === undefined || index === -1) {
      continue;
    }

    const name = pair.slice(0, index);
    const value = pair.slice(index + 1);

    if (value === "") {
      delete jar[name];

      continue;
    }

    jar[name] = decodeURIComponent(value);
  }

  return jar;
}

/**
 * Drive redirect → callback, carrying the cookie across and minting an
 * `id_token` whose `nonce` matches whatever the redirect issued.
 *
 * The nonce has to come from the real flow, which is the point: a test
 * that hardcoded one would not be checking the binding.
 */
export async function roundTrip(
  harness: Harness,
  options: {
    claims?: IdTokenClaims;
    alg?: string;
    /** Sign with this pair instead, so the header's `kid` matches it. */
    signWith?: Keys;
    key?: KeyObject | CryptoKey | Uint8Array;
    userinfo?: Record<string, unknown>;
    discovery?: Record<string, unknown>;
    jwks?: { keys: JWK[] };
    nonce?: string | null;
  } = {},
): Promise<Request> {
  fakeIssuer({ keys: harness.keys, discovery: options.discovery, jwks: options.jwks });

  const driver = harness.manager.driver("work");
  const redirect = redirectRequest();
  const url = new URL(await driver.redirect(redirect));

  const issuedNonce = url.searchParams.get("nonce");
  const nonce = options.nonce === undefined ? issuedNonce : options.nonce;

  const idToken = await mintIdToken(
    options.signWith ?? harness.keys,
    { nonce, ...options.claims },
    { alg: options.alg, key: options.key },
  );

  fakeIssuer({
    keys: harness.keys,
    idToken,
    userinfo: options.userinfo,
    discovery: options.discovery,
    jwks: options.jwks,
  });

  return callbackRequest(
    { code: "the-code", state: url.searchParams.get("state") ?? "" },
    queuedCookies(redirect),
  );
}

export async function captureError<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("Expected the promise to reject, but it resolved.");
}
