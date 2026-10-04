import {
  app,
  canonicalPayload,
  computeSignature,
  EXPIRES_PARAM,
  SIGNATURE_PARAM,
  type Application,
} from "@mahiframework/core";
import type { Signer } from "@mahiframework/encryption";
import { RouteRegistry } from "./route-registry.js";
import { REQUEST_ROOT_CONTEXT_KEY } from "./request.js";
import type { HttpConfig } from "./http-config.js";
import { resolveSigner } from "./signed-url.js";

/** Value a route param may be substituted with. */
export type RouteParamValue = string | number;
export type RouteParams = Record<string, RouteParamValue>;

export interface UrlOptions {
  /**
   * Whether to return an absolute URL (scheme + host + path), the
   * default, matching Laravel, or a root-relative path (`false`).
   */
  absolute?: boolean;
}

export interface SignedRouteOptions extends UrlOptions {
  /** Seconds from now until the link expires. Omit for a non-expiring signature. */
  expiresInSeconds?: number;
  /** Override the resolved `Signer` (tests). */
  signer?: Signer;
  /** Absolute unix-seconds override for "now" (tests). */
  now?: number;
}

export class RouteNotFoundError extends Error {
  constructor(name: string) {
    super(`Route [${name}] is not defined.`);
    this.name = "RouteNotFoundError";
  }
}

/**
 * Generates URLs for named routes, the equivalent of Laravel's
 * `UrlGenerator`/`route()` helper and the `URL` facade. Bound as a
 * singleton at `URL_GENERATOR_TOKEN`; reach it via the `URL` facade.
 *
 * Absolute URLs borrow the in-flight request's scheme+host (published into
 * the per-request `Context` overlay by `Request`), falling back to the
 * `http.url` config for out-of-request callers (queue jobs, CLI). A signed
 * route reuses the same HMAC machinery as `signedUrl()`.
 */
export class UrlGenerator {
  constructor(
    private readonly application: Application,
    private readonly registry: RouteRegistry,
  ) {}

  /**
   * Absolute URL for a bare path, `URL.to("/dashboard")`. Passes through
   * an already-absolute URL unchanged.
   */
  to(path: string, options: UrlOptions = {}): string {
    if (/^https?:\/\//i.test(path)) {
      return path;
    }

    const normalized = path.startsWith("/") ? path : `/${path}`;

    return options.absolute === false ? normalized : `${this.root()}${normalized}`;
  }

  /**
   * URL for a named route, substituting `{param}` segments from `params`
   * and appending any leftover params as a query string.
   *
   *   URL.route("posts.show", { post: 42 });          // http://host/posts/42
   *   URL.route("posts.show", { post: 42 }, { absolute: false }); // /posts/42
   */
  route(name: string, params: RouteParams = {}, options: UrlOptions = {}): string {
    const route = this.registry.get(name);

    if (!route) {
      throw new RouteNotFoundError(name);
    }

    const { path, query } = this.substitute(route.path, params);
    const search = buildQuery(query);
    const relative = search ? `${path}?${search}` : path;

    return options.absolute === false ? relative : `${this.root()}${relative}`;
  }

  /**
   * Signed URL for a named route, a tamper-evident link with an optional
   * expiry, the equivalent of Laravel's `URL::signedRoute()` /
   * `temporarySignedRoute()`. Verify it on the receiving route with
   * `validateSignature()` / `hasValidSignature()`.
   *
   *   URL.signedRoute("unsubscribe", { user: id }, { expiresInSeconds: 86400 });
   */
  signedRoute(name: string, params: RouteParams = {}, options: SignedRouteOptions = {}): string {
    const route = this.registry.get(name);

    if (!route) {
      throw new RouteNotFoundError(name);
    }

    const { path, query } = this.substitute(route.path, params);

    if (SIGNATURE_PARAM in query || EXPIRES_PARAM in query) {
      throw new Error(
        `"${SIGNATURE_PARAM}" and "${EXPIRES_PARAM}" are reserved parameters when signing a route.`,
      );
    }

    const allParams: Record<string, string> = {};

    for (const [key, value] of Object.entries(query)) {
      allParams[key] = String(value);
    }

    if (options.expiresInSeconds !== undefined) {
      const now = options.now ?? Math.floor(Date.now() / 1000);
      allParams[EXPIRES_PARAM] = String(now + options.expiresInSeconds);
    }

    // The signature must cover exactly what `hasValidSignature()` will
    // rebuild on the receiving end: the request path (never absolute) plus
    // the sorted query. So sign the relative path regardless of `absolute`.
    const payload = canonicalPayload(path, allParams);
    const signer = resolveSigner(options.signer);
    allParams[SIGNATURE_PARAM] = computeSignature(payload, signer);

    const search = new URLSearchParams(allParams).toString();
    const relative = `${path}?${search}`;

    return options.absolute === false ? relative : `${this.root()}${relative}`;
  }

  /** Whether a route name is registered. */
  has(name: string): boolean {
    return this.registry.has(name);
  }

  /**
   * Substitute `{param}` segments in a route path with `params` values,
   * URL-encoding each. Leftover params (not consumed by a segment) are
   * returned as `query` for the caller to append. Throws on a missing
   * required segment, matching Laravel's `UrlGenerationException`.
   */
  private substitute(pattern: string, params: RouteParams): { path: string; query: RouteParams } {
    const consumed = new Set<string>();
    const path = pattern.replace(
      /\{([A-Za-z0-9_]+)(\?)?\}/g,
      (_all, key: string, optional?: string) => {
        const value = params[key];

        if (value === undefined) {
          if (optional) {
            consumed.add(key);

            return "";
          }

          throw new Error(`Missing required parameter "${key}" for route "${pattern}".`);
        }

        consumed.add(key);

        return encodeURIComponent(String(value));
      },
    );

    const query: RouteParams = {};

    for (const [key, value] of Object.entries(params)) {
      if (!consumed.has(key)) {
        query[key] = value;
      }
    }

    // Collapse a `/x//y` or trailing `/` left by an omitted optional segment.
    const cleaned = path.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";

    return { path: cleaned, query };
  }

  /**
   * The scheme+host used for absolute URLs. Prefers the in-flight
   * request's root (per-request Context overlay), then `http.url` config.
   * Throws if neither is available, since silently emitting a relative URL
   * where an absolute one was asked for hides a misconfiguration.
   */
  private root(): string {
    const fromRequest = this.application.context.get<string>(REQUEST_ROOT_CONTEXT_KEY);

    if (fromRequest) {
      return stripTrailingSlash(fromRequest);
    }

    const configured = this.application.config.get<HttpConfig["url"]>("http.url");

    if (configured) {
      return stripTrailingSlash(configured);
    }

    throw new Error(
      "Cannot generate an absolute URL: no active request and no `http.url` " +
        "config set. Set `http.url` (APP_URL) or pass `{ absolute: false }`.",
    );
  }
}

function buildQuery(params: RouteParams): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    search.set(key, String(value));
  }

  return search.toString();
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export const URL_GENERATOR_TOKEN = "url.generator";

/** Resolve the shared `UrlGenerator` from the current application. */
export function urlGenerator(): UrlGenerator {
  return app().make<UrlGenerator>(URL_GENERATOR_TOKEN);
}
