import { randomBytes } from "node:crypto";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { Signer, SIGNER_TOKEN } from "@mahiframework/encryption";
import { Request } from "@mahiframework/http";
import { Http } from "@mahiframework/http-client";
import { SocialiteServiceProvider } from "../../src/socialite-service-provider.js";
import { SOCIALITE_TOKEN } from "../../src/tokens.js";
import type { SocialiteConfig } from "../../src/socialite-config.js";
import type { SocialiteManager } from "../../src/socialite-manager.js";

export interface Harness {
  app: Application;
  manager: SocialiteManager;
  signer: Signer;
  cleanup: () => void;
}

/** The GitHub endpoints every happy-path test stubs. */
export const GITHUB_STUBS = {
  "github.com/login/oauth/access_token": {
    access_token: "gho_token",
    scope: "user:email",
  },
  "api.github.com/user": {
    id: 1234,
    node_id: "MDQ6VXNlcjEyMzQ=",
    login: "ada",
    avatar_url: "https://avatars.example.test/ada.png",
    name: "Ada Lovelace",
  },
  "api.github.com/user/emails": [
    { email: "noreply@example.test", primary: false, verified: true },
    { email: "ada@example.test", primary: true, verified: true },
  ],
};

/** A config with one fully-specified GitHub provider. */
export function githubConfig(overrides: SocialiteConfig = {}): SocialiteConfig {
  return {
    providers: {
      github: {
        clientId: "client-id",
        clientSecret: "client-secret",
        redirect: "https://app.test/auth/github/callback",
      },
    },
    // `secure: false` so the cookie has no `__Host-`/`Secure` constraints
    // to satisfy in a test that never speaks HTTPS.
    cookie: { secure: false },
    ...overrides,
  };
}

/**
 * An application with the real provider registered.
 *
 * Framework-package style, no `@mahiframework/testing` dependency.
 *
 * Unusually small for a harness in this repo, because this package owns
 * no tables and no models: a `Signer` and a config are the whole
 * dependency surface. `Http.fake()` stands in for every provider, so
 * nothing reaches the network and no live credentials exist.
 */
export function createHarness(config: SocialiteConfig = githubConfig()): Harness {
  const app = new Application();
  const signer = new Signer(randomBytes(32));

  app.instance(SIGNER_TOKEN, signer);
  setCurrentApp(app);

  app.config.set("socialite", config);

  new SocialiteServiceProvider(app).register();

  Http.fake(GITHUB_STUBS);

  return {
    app,
    manager: app.make<SocialiteManager>(SOCIALITE_TOKEN),
    signer,
    cleanup: () => {
      // `Http` is a static facade over module-level state, so a fake
      // left in place would leak into the next file.
      Http.restore();
      clearCurrentApp();
    },
  };
}

/** A request standing in for "send me to the provider". */
export function redirectRequest(): Request {
  return Request.create("/auth/github/redirect");
}

/** A request standing in for the provider's callback. */
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

  return Request.create("/auth/github/callback", "GET", {}, { query, headers });
}

/**
 * The cookies a request queued, as a name → value map.
 *
 * The driver queues its state onto the *redirect* request, and the
 * browser would present it on the *callback* request. Tests have no
 * browser, so this is the hand-rolled equivalent of a cookie jar — and
 * the round trip is precisely what the state check is protecting, so it
 * has to be real rather than stubbed.
 */
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

    // A deletion is `name=; Max-Age=0`; keeping it would hand the
    // callback an empty cookie instead of none.
    if (value === "") {
      delete jar[name];

      continue;
    }

    jar[name] = decodeURIComponent(value);
  }

  return jar;
}

/** The `state` parameter out of an authorization URL. */
export function stateOf(url: string): string {
  const state = new URL(url).searchParams.get("state");

  if (state === null) {
    throw new Error(`No state parameter on ${url}`);
  }

  return state;
}

/**
 * Drive a full redirect → callback round trip, carrying the state cookie
 * across the way a browser would.
 */
export async function roundTrip(
  harness: Harness,
  options: { code?: string; driver?: string } = {},
): Promise<Request> {
  const driver = harness.manager.driver(options.driver ?? "github");
  const redirect = redirectRequest();
  const url = await driver.redirect(redirect);

  return callbackRequest(
    { code: options.code ?? "the-code", state: stateOf(url) },
    queuedCookies(redirect),
  );
}

/** Await a promise and return whatever it threw. */
export async function captureError<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("Expected the promise to reject, but it resolved.");
}
