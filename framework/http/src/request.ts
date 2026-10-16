import type { Context } from "hono";
import { Collection, app } from "@mahiframework/core";
import { Validator, ValidationException, type InferRules } from "@mahiframework/validation";
import { HttpError } from "./http-error.js";
import {
  expiredCookie,
  parseCookies,
  serializeCookie,
  type CookieOptions,
  type QueuedCookie,
} from "./cookies.js";
import { peerAddressFrom } from "./conninfo.js";
import { parseNestedEntries, parseNestedQuery } from "./query-parser.js";

export const REQUEST_CONTEXT_KEY = "__mahi_request";

/**
 * Context key under which each request stashes its own root URL
 * (`scheme://host`). The URL generator reads this to make an absolute URL
 * borrow the live request's host, falling back to the `http.url` config
 * outside a request (queue jobs, CLI). Uses the per-request `Context`
 * overlay, so concurrent requests never see each other's root.
 */
export const REQUEST_ROOT_CONTEXT_KEY = "__mahi_request_root";

export interface RequestCreateExtras {
  query?: Record<string, string>;
  headers?: Record<string, string>;
  files?: Record<string, File | File[]>;
  params?: Record<string, string>;
  /**
   * Simulated socket peer address. Named for what it is, the TCP peer,
   * not "the client IP", because that distinction is the whole subject
   * of `ip()` below. Tests that want to exercise proxy handling set this
   * *and* an `x-forwarded-for` header, then run `trustProxies()`.
   */
  ip?: string;
}

type RulesOf<T> = T extends { rules: () => infer R } ? R : Record<string, never>;

/**
 * Incoming HTTP request. Wraps Hono's context after a single eager body
 * parse in `from()`, then exposes a Laravel-shaped, fully synchronous
 * accessor surface. Subclass and implement `rules()` to validate.
 *
 * App code never takes Hono `Context`, the kernel constructs one
 * `Request` per call and threads it through pipes and the controller.
 * `raw()` is the escape hatch back to Hono.
 */
export class Request {
  protected methodName = "GET";
  protected pathName = "/";
  protected urlPath = "/";
  protected fullUrlValue = "/";
  protected schemeName = "http";
  protected hostName = "localhost";
  protected queryBag: Record<string, unknown> = {};
  protected paramBag: Record<string, string> = {};
  protected inputBag: Record<string, unknown> = {};
  protected bodyBag: Record<string, unknown> = {};
  protected fileBag: Record<string, File | File[]> = {};
  protected headerBag: Record<string, string> = {};
  /**
   * The socket peer address, captured at parse time. NOT the client IP
   * when a proxy is in front. See `ip()`.
   */
  protected peerIp: string | undefined;
  protected resolvedIp: string | undefined;
  protected rawContext: Context | undefined;
  protected sharedBag = new Map<string, unknown>();
  protected modelCache = new Map<string, unknown>();
  protected cookieBag: Record<string, string> | undefined;
  /**
   * Cookies queued for the response. Shared by reference with any
   * subclass upgrade of this request (see `copyStateFrom`), so a queue
   * from a global pipe survives a controller's typed `Request` swap.
   */
  protected queuedCookies: QueuedCookie[] = [];
  protected validatedPayload: Record<string, unknown> | undefined;
  protected errorBag: Record<string, string[]> = {};
  protected validateRan = false;
  protected prepareRan = false;
  /**
   * The route PATTERN this request matched (`/posts/{post}`), as opposed
   * to `pathName`, the concrete path (`/posts/42`). Set once Hono has
   * matched a route; `undefined` in a global pipe that runs before
   * matching. See `routePattern()`.
   */
  protected matchedRoutePattern: string | undefined;

  constructor(input: Record<string, unknown> = {}) {
    this.bodyBag = { ...input };
    this.rebuildInput();
  }

  /**
   * Parse the Hono context once. After this, every accessor is sync.
   * Invalid/empty JSON becomes `{}`, validation decides whether that's an error.
   */
  static async from<R extends Request>(
    this: (new (...args: any[]) => R) & { fromExisting(source: Request): R },
    c: Context,
  ): Promise<R> {
    const existing = c.get(REQUEST_CONTEXT_KEY) as Request | undefined;

    if (existing) {
      existing.syncRouteParams(c);

      return this.fromExisting(existing);
    }

    const instance = new this();
    await instance.populateFromContext(c);
    c.set(REQUEST_CONTEXT_KEY, instance);

    return instance;
  }

  /** Unit tests / non-HTTP callers. */
  static create<R extends Request>(
    this: new (...args: any[]) => R,
    path: string,
    method = "GET",
    input: Record<string, unknown> = {},
    extras: RequestCreateExtras = {},
  ): R {
    const instance = new this(input);
    instance.hydrate({
      method: method.toUpperCase(),
      path: path.split("?")[0] ?? path,
      query: extras.query ?? queryFromPath(path),
      params: extras.params ?? {},
      input,
      files: extras.files ?? {},
      headers: extras.headers ?? {},
      ip: extras.ip,
    });

    return instance;
  }

  /** Upgrade a base Request into a subclass, copying the already-parsed bags. */
  static fromExisting<R extends Request>(this: new (...args: any[]) => R, source: Request): R {
    if (source instanceof this) {
      return source as R;
    }

    const instance = new this();
    instance.copyStateFrom(source);

    if (source.rawContext) {
      source.rawContext.set(REQUEST_CONTEXT_KEY, instance);
    }

    return instance;
  }

  protected copyStateFrom(source: Request): void {
    this.methodName = source.methodName;
    this.pathName = source.pathName;
    this.urlPath = source.urlPath;
    this.fullUrlValue = source.fullUrlValue;
    this.schemeName = source.schemeName;
    this.hostName = source.hostName;
    this.queryBag = source.queryBag;
    this.paramBag = source.paramBag;
    this.bodyBag = source.bodyBag;
    this.inputBag = source.inputBag;
    this.fileBag = source.fileBag;
    this.headerBag = source.headerBag;
    this.peerIp = source.peerIp;
    this.resolvedIp = source.resolvedIp;
    this.rawContext = source.rawContext;
    this.sharedBag = source.sharedBag;
    this.modelCache = source.modelCache;
    this.cookieBag = source.cookieBag;
    // By reference, not a copy: `fromExisting()` upgrades a base Request
    // into a controller's typed subclass mid-request, and a cookie queued
    // before that point (by a global pipe, or by `SessionGuard.login()`)
    // must still be on the queue the boundary drains.
    this.queuedCookies = source.queuedCookies;
    this.matchedRoutePattern = source.matchedRoutePattern;
  }

  protected copySharedFrom(source: Request): void {
    this.sharedBag = source.sharedBag;
    this.modelCache = source.modelCache;
    this.queuedCookies = source.queuedCookies;
  }

  protected hydrate(state: {
    method: string;
    path: string;
    query: Record<string, unknown>;
    params: Record<string, string>;
    input: Record<string, unknown>;
    files: Record<string, File | File[]>;
    headers: Record<string, string>;
    ip?: string;
    raw?: Context;
    url?: string;
    fullUrl?: string;
    scheme?: string;
    host?: string;
  }): void {
    this.methodName = state.method.toUpperCase();
    this.pathName = state.path.startsWith("/") ? state.path : `/${state.path}`;
    this.queryBag = { ...state.query };
    this.paramBag = { ...state.params };
    this.fileBag = state.files;
    this.headerBag = lowercaseKeys(state.headers);
    this.peerIp = state.ip;
    this.rawContext = state.raw;
    this.schemeName = state.scheme ?? "http";
    this.hostName = state.host ?? "localhost";
    this.urlPath = state.url ?? `${this.schemeName}://${this.hostName}${this.pathName}`;
    // Publish this request's root into the per-request Context overlay so
    // the URL generator can borrow it for absolute URLs even when called
    // outside the handler (e.g. from a Resource). Best-effort: no-op when
    // the app container isn't available (unit-constructed requests).
    this.publishRoot();
    this.fullUrlValue = state.fullUrl ?? this.buildFullUrl();
    // Laravel merge order: route params + query + body, later wins.
    this.bodyBag = { ...state.input };
    this.rebuildInput();
  }

  /** `url?query`, flattening any nested query values back to brackets. */
  protected buildFullUrl(): string {
    const search = new URLSearchParams(flattenToPairs(this.queryBag)).toString();

    return search ? `${this.urlPath}?${search}` : this.urlPath;
  }

  /**
   * Global `use("*")` pipes construct Request before Hono has matched a
   * route, so `c.req.param()` is empty. Re-read params, and the matched
   * route pattern, once the route handler (or route-level pipe) runs.
   */
  syncRouteParams(c: Context): void {
    this.paramBag = { ...c.req.param() };
    this.captureRoutePattern(c);
    this.rebuildInput();
  }

  /**
   * Record the matched route pattern (`/posts/:post` in Hono's form,
   * normalised to `/posts/{post}`).
   *
   * Guarded because `routePath` throws on a context that never went
   * through the router, `Request.create()` in a unit test, or a global
   * pipe running before any match.
   */
  protected captureRoutePattern(c: Context): void {
    try {
      const pattern = c.req.routePath;

      // Hono reports "/*" for a middleware-only match; that is not a
      // route and keying anything on it would merge unrelated paths.
      if (pattern && pattern !== "/*") {
        this.matchedRoutePattern = honoPathToBraces(pattern);
      }
    } catch {
      // No match result on this context, leave it unset.
    }
  }

  /**
   * The route PATTERN this request matched, `/posts/{post}`, not
   * `/posts/42`, or `undefined` before the router has matched.
   *
   * The distinction matters wherever a path is used as an identity: a
   * rate-limit bucket keyed on the concrete path gives an attacker a
   * fresh quota per id (`/posts/1`, `/posts/2`, …), which is not a
   * limit at all. See `throttle()`.
   */
  routePattern(): string | undefined {
    return this.matchedRoutePattern;
  }

  protected rebuildInput(): void {
    this.inputBag = { ...this.paramBag, ...this.queryBag, ...this.bodyBag };
  }

  protected async populateFromContext(c: Context): Promise<void> {
    const contentType = c.req.header("content-type") ?? "";
    let input: Record<string, unknown> = {};
    const files: Record<string, File | File[]> = {};

    if (contentType.includes("application/json") || contentType.includes("+json")) {
      try {
        const parsed = await c.req.json();
        input =
          parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch {
        input = {};
      }
    } else if (
      contentType.includes("multipart/form-data") ||
      contentType.includes("application/x-www-form-urlencoded")
    ) {
      const parsed = await c.req.parseBody({ all: true });
      const scalarEntries: Array<[string, string]> = [];

      for (const [key, value] of Object.entries(parsed)) {
        if (isFile(value)) {
          files[key] = value;
        } else if (Array.isArray(value) && value.length > 0 && value.every(isFile)) {
          files[key] = value as File[];
        } else if (Array.isArray(value)) {
          // Hono's `{ all: true }` already collapses repeated keys into
          // an array; feed each occurrence through the bracket parser so
          // `tags[]` nests the same way it does in a query string.
          for (const item of value) {
            scalarEntries.push([key, String(item)]);
          }
        } else {
          scalarEntries.push([key, String(value)]);
        }
      }

      input = parseNestedEntries(scalarEntries);
    }

    let url: URL | undefined;
    try {
      url = new URL(c.req.url);
    } catch {
      url = undefined;
    }

    this.hydrate({
      method: c.req.method,
      path: c.req.path,
      // `c.req.query()` keeps only the first value of a repeated key and
      // never expands brackets. See `parseNestedQuery`. Parse the raw
      // search string instead so `?ids[]=1&ids[]=2` is an actual array.
      query: parseNestedQuery(url?.search ?? ""),
      params: c.req.param(),
      input,
      files,
      headers: headerRecord(c),
      // The SOCKET PEER, not `x-forwarded-for`. `ip()` decides what the
      // client address is; seeding it from a header here would make that
      // decision unforgeably early and in the wrong place.
      ip: peerAddressFrom(c),
      raw: c,
      url: url ? `${url.protocol}//${url.host}${url.pathname}` : c.req.path,
      fullUrl: c.req.url,
      scheme: url?.protocol.replace(":", "") ?? "http",
      host: url?.host ?? c.req.header("host") ?? "localhost",
    });

    this.captureRoutePattern(c);
  }

  method(): string {
    return this.methodName;
  }

  isMethod(method: string): boolean {
    return this.methodName === method.toUpperCase();
  }

  path(): string {
    return this.pathName;
  }

  url(): string {
    return this.urlPath;
  }

  fullUrl(): string {
    return this.fullUrlValue;
  }

  fullUrlWithQuery(query: Record<string, string | null | undefined>): string {
    const current = new URL(this.fullUrlValue, "http://localhost");

    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined) {
        current.searchParams.delete(key);
      } else {
        current.searchParams.set(key, value);
      }
    }

    const search = current.searchParams.toString();

    return search ? `${this.urlPath}?${search}` : this.urlPath;
  }

  root(): string {
    return `${this.schemeName}://${this.hostName}`;
  }

  /** Best-effort: record this request's root in the Context overlay. */
  protected publishRoot(): void {
    try {
      app().context.add(REQUEST_ROOT_CONTEXT_KEY, this.root());
    } catch {
      // No container / no scope (unit-constructed request). The URL
      // generator will fall back to the http.url config.
    }
  }

  httpHost(): string {
    return this.hostName;
  }

  scheme(): string {
    return this.schemeName;
  }

  secure(): boolean {
    return this.schemeName === "https";
  }

  /**
   * Override the scheme and/or host this request believes it was made
   * on, re-deriving `root()`, `url()`, `fullUrl()` and `secure()`, and
   * republishing the root the URL generator reads.
   *
   * Called by `trustProxies()` after it has confirmed the peer is a
   * trusted proxy, to apply `X-Forwarded-Proto`/`-Host`/`-Port`. It is
   * the only supported way to change these, and deliberately not
   * something a route handler should use: the forwarding headers
   * are client-controlled until a trust boundary says otherwise, and
   * that boundary lives in exactly one place.
   *
   * Without this, an app behind a TLS terminator sees every request as
   * plain `http`, so `secure()` is useless for cookie decisions and
   * every generated link (password reset, email verification, signed
   * URLs) goes out as `http://`, which is both a downgrade and, for
   * links a browser refuses to follow, simply broken.
   */
  setForwardedOrigin(origin: { scheme?: string; host?: string }): this {
    if (origin.scheme) {
      this.schemeName = origin.scheme;
    }

    if (origin.host) {
      this.hostName = origin.host;
    }

    this.urlPath = `${this.schemeName}://${this.hostName}${this.pathName}`;
    this.fullUrlValue = this.buildFullUrl();
    this.publishRoot();

    return this;
  }

  is(pattern: string): boolean {
    const regex = new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
    );

    return regex.test(this.pathName);
  }

  header(key: string, defaultValue?: string): string | undefined {
    if (this.rawContext) {
      return this.rawContext.req.header(key) ?? defaultValue;
    }

    return this.headerBag[key.toLowerCase()] ?? defaultValue;
  }

  headers(): Record<string, string> {
    return { ...this.headerBag };
  }

  bearerToken(): string | undefined {
    const header = this.header("Authorization");

    if (!header) {
      return undefined;
    }

    const match = /^Bearer\s+(.+)$/i.exec(header.trim());

    return match?.[1]?.trim() || undefined;
  }

  /**
   * The client IP: the **socket peer address**, unless `trustProxies()`
   * has established that the peer is a trusted proxy and resolved a real
   * client address from `X-Forwarded-For`.
   *
   * `X-Forwarded-For` is never consulted here. That is the entire point.
   * It is a header, so any client can set it to anything; when `ip()`
   * read it by default, the framework's own rate limiter could be
   * defeated by rotating a fake value, an attacker got an unlimited
   * number of login attempts by incrementing a string, and, worse,
   * every client that sent no header at all shared one bucket, so a
   * `throttle()` on `/login` was a global lockout switch anyone could
   * flip. Both were reproduced against a scaffolded app.
   *
   * Returns `undefined` only when there is genuinely no peer to name:
   * an in-process dispatch (`hono.request()` in tests) or a non-Node
   * adapter. Callers keying anything security-relevant must treat that
   * as "unknown client", not as a usable identity.
   */
  ip(): string | undefined {
    return this.resolvedIp ?? this.peerIp;
  }

  /**
   * The immediate TCP peer, ignoring any proxy resolution. This is the
   * address of whatever opened the socket, the proxy itself, when there
   * is one. Mostly useful for logging and for asserting a proxy is where
   * you think it is.
   */
  peerAddress(): string | undefined {
    return this.peerIp;
  }

  /**
   * Set the authoritative client IP for this request. Called by
   * `trustProxies()` once it has decided whether, and how far,
   * `x-forwarded-for` may be trusted. Passing `undefined` clears the
   * override, falling back to the socket peer.
   */
  setResolvedIp(ip: string | undefined): this {
    this.resolvedIp = ip;

    return this;
  }

  /**
   * The full client-address chain, closest hop last: every
   * `X-Forwarded-For` entry followed by the socket peer.
   *
   * **Unvalidated by design**. The leading entries are client-supplied
   * and only the last one is proven. Use it for diagnostics; use `ip()`
   * for decisions.
   */
  ips(): string[] {
    const forwarded = this.header("x-forwarded-for");
    const chain = forwarded
      ? forwarded
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)
      : [];

    if (this.peerIp) {
      chain.push(this.peerIp);
    }

    return chain;
  }

  userAgent(): string | undefined {
    return this.header("user-agent");
  }

  isJson(): boolean {
    const contentType = this.header("content-type") ?? "";

    return contentType.includes("application/json") || contentType.includes("+json");
  }

  /**
   * All cookies sent with this request, decoded. Parsed once and cached.
   */
  cookies(): Record<string, string> {
    this.cookieBag ??= parseCookies(this.header("cookie"));

    return { ...this.cookieBag };
  }

  /**
   * One inbound cookie by name, or `undefined`.
   *
   * Pass the `prefix` used when writing it (`"host"`/`"secure"`) so the
   * `__Host-`/`__Secure-` name mangling stays an implementation detail of
   * the cookie API rather than something every caller re-derives.
   */
  cookie(name: string, prefix?: CookieOptions["prefix"]): string | undefined {
    this.cookieBag ??= parseCookies(this.header("cookie"));

    return this.cookieBag[prefixedCookieName(name, prefix)];
  }

  /**
   * Queue a cookie to be written onto this request's response.
   *
   * Deliberately NOT Hono's `setCookie()`: Hono only merges
   * context-queued headers into a response it built itself
   * (`c.json()`/`c.newResponse()`), and Mahi handlers return platform
   * `Response` objects, so a cookie set through Hono is silently
   * dropped. The queue is drained at the HTTP boundary instead, where the
   * framework owns the final headers. See `cookies.ts`.
   *
   *   request.queueCookie("session", id, { httpOnly: true, maxAge: 7200 });
   *
   * Queuing the same name twice replaces the earlier entry, so a guard
   * that re-issues a cookie (a sliding session) emits one `Set-Cookie`,
   * not two contradictory ones.
   */
  queueCookie(name: string, value: string, options: CookieOptions = {}): this {
    const key = cookieIdentity(name, options);
    const existing = this.queuedCookies.findIndex(
      (queued) => cookieIdentity(queued.name, queued.options) === key,
    );

    const cookie: QueuedCookie = { name, value, options };

    if (existing === -1) {
      this.queuedCookies.push(cookie);
    } else {
      this.queuedCookies[existing] = cookie;
    }

    return this;
  }

  /**
   * Queue the deletion of a cookie.
   *
   * `path`/`domain` must match those the cookie was written with, or the
   * browser treats it as a different cookie and silently keeps the
   * original, the classic "logout didn't log out" bug.
   */
  queueCookieForget(name: string, options: CookieOptions = {}): this {
    return this.queueCookie(name, "", { ...options, maxAge: 0, expires: new Date(0) });
  }

  /** Drop a queued cookie without writing a deletion for it. */
  unqueueCookie(name: string, options: CookieOptions = {}): this {
    const key = cookieIdentity(name, options);
    this.queuedCookies = this.queuedCookies.filter(
      (queued) => cookieIdentity(queued.name, queued.options) !== key,
    );

    return this;
  }

  /** The queued cookies, as `Set-Cookie` header values. */
  queuedCookieHeaders(): string[] {
    return this.queuedCookies.map((cookie) =>
      cookie.options.maxAge === 0
        ? expiredCookie(cookie.name, cookie.options)
        : serializeCookie(cookie.name, cookie.value, cookie.options),
    );
  }

  /**
   * Serialize the queued cookies AND empty the queue.
   *
   * Called by the HTTP boundary, which runs more than once per request:
   * the route handler finalizes its response, and then every enclosing
   * global-middleware frame finalizes on the way back out. Without the
   * clear, each frame would re-emit the same cookie and the browser would
   * receive several identical `Set-Cookie` headers for one login.
   *
   * Clearing is also what makes the ordering work: a pipe that queues a
   * cookie *after* `next()` returns still gets it written, because its
   * own frame drains a queue that is empty except for what it just added.
   */
  flushQueuedCookies(): string[] {
    const headers = this.queuedCookieHeaders();
    this.queuedCookies.length = 0;

    return headers;
  }

  /** The queued cookies, unserialized, for tests and for `Response` merging. */
  queuedCookieList(): readonly QueuedCookie[] {
    return this.queuedCookies;
  }

  accepts(...types: string[]): boolean {
    const accept = this.header("accept") ?? "*/*";

    if (accept.includes("*/*")) {
      return true;
    }

    return types.some((type) => accept.toLowerCase().includes(type.toLowerCase()));
  }

  prefers(types: string[]): string | undefined {
    const accept = (this.header("accept") ?? "").toLowerCase();

    for (const type of types) {
      if (accept.includes(type.toLowerCase())) {
        return type;
      }
    }

    return types[0];
  }

  wantsJson(): boolean {
    const accept = this.header("accept") ?? "";
    const first = accept.split(",")[0]?.trim() ?? "";

    return first.toLowerCase().includes("json");
  }

  expectsJson(): boolean {
    return this.wantsJson() || this.accepts("application/json", "json");
  }

  /**
   * Query parameters, with bracket notation expanded:
   * `?ids[]=1&ids[]=2` is `{ ids: ["1", "2"] }` and `?user[name]=bob` is
   * `{ user: { name: "bob" } }` (see `query-parser.ts`).
   *
   * The single-key overload returns a **string or undefined**, so the
   * common `request.query("page")` stays simple and typed. A key holding
   * an array or object is treated as "no usable string here" and yields
   * `defaultValue` (or `undefined`), the same as a missing key, use
   * the no-arg form (or `input()`) to read a structured value.
   */
  query(): Record<string, unknown>;
  query(key: string, defaultValue?: string): string | undefined;
  query(key?: string, defaultValue?: string): Record<string, unknown> | string | undefined {
    if (key === undefined) {
      return { ...this.queryBag };
    }

    const value = this.queryBag[key];

    return typeof value === "string" ? value : defaultValue;
  }

  /**
   * The raw query string, without a leading `?`, exactly as it arrived,
   * unexpanded.
   *
   * Signature verification needs this: an HMAC covers literal bytes, so
   * rebuilding the payload from the *parsed* bag would hash a different
   * string than the one that was signed the moment any key contains a
   * bracket. See `signed-url.ts`.
   */
  queryString(): string {
    const index = this.fullUrlValue.indexOf("?");

    return index === -1 ? "" : this.fullUrlValue.slice(index + 1);
  }

  input(): Record<string, unknown>;
  input(key: string, defaultValue?: unknown): unknown;
  input(key?: string, defaultValue?: unknown): unknown {
    if (key === undefined) {
      return { ...this.inputBag };
    }

    return Object.prototype.hasOwnProperty.call(this.inputBag, key)
      ? this.inputBag[key]
      : defaultValue;
  }

  all(): Record<string, unknown> {
    return { ...this.inputBag };
  }

  only(...keys: string[]): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(this.inputBag, key)) {
        result[key] = this.inputBag[key];
      }
    }

    return result;
  }

  except(...keys: string[]): Record<string, unknown> {
    const skip = new Set(keys);
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(this.inputBag)) {
      if (!skip.has(key)) {
        result[key] = value;
      }
    }

    return result;
  }

  has(...keys: string[]): boolean {
    return keys.every((key) => Object.prototype.hasOwnProperty.call(this.inputBag, key));
  }

  hasAny(...keys: string[]): boolean {
    return keys.some((key) => Object.prototype.hasOwnProperty.call(this.inputBag, key));
  }

  filled(...keys: string[]): boolean {
    const check = keys.length === 0 ? Object.keys(this.inputBag) : keys;

    return check.every((key) => {
      const value = this.inputBag[key];

      return value !== undefined && value !== null && value !== "";
    });
  }

  missing(...keys: string[]): boolean {
    return keys.every((key) => !Object.prototype.hasOwnProperty.call(this.inputBag, key));
  }

  boolean(key: string): boolean {
    const value = this.inputBag[key];

    return (
      value === true ||
      value === 1 ||
      value === "1" ||
      value === "true" ||
      value === "on" ||
      value === "yes"
    );
  }

  integer(key: string): number | undefined {
    const value = this.inputBag[key];

    if (value === undefined || value === null || value === "") {
      return undefined;
    }

    const n = parseInt(String(value), 10);

    return Number.isFinite(n) ? n : undefined;
  }

  float(key: string): number | undefined {
    const value = this.inputBag[key];

    if (value === undefined || value === null || value === "") {
      return undefined;
    }

    const n = parseFloat(String(value));

    return Number.isFinite(n) ? n : undefined;
  }

  string(key: string): string | undefined {
    const value = this.inputBag[key];

    if (value === undefined || value === null) {
      return undefined;
    }

    return String(value);
  }

  merge(values: Record<string, unknown>): this {
    Object.assign(this.bodyBag, values);
    this.rebuildInput();

    return this;
  }

  mergeIfMissing(values: Record<string, unknown>): this {
    for (const [key, value] of Object.entries(values)) {
      if (!Object.prototype.hasOwnProperty.call(this.inputBag, key)) {
        this.bodyBag[key] = value;
      }
    }

    this.rebuildInput();

    return this;
  }

  replace(values: Record<string, unknown>): this {
    this.bodyBag = { ...values };
    this.rebuildInput();

    return this;
  }

  route(): Record<string, string>;
  route(param: string): string | undefined;
  route(param?: string): Record<string, string> | string | undefined {
    if (param === undefined) {
      return { ...this.paramBag };
    }

    return this.paramBag[param];
  }

  /** Throwing variant of `route(param)`. The param is required by the route pattern. */
  parameter(name: string): string {
    const value = this.paramBag[name];

    if (value === undefined) {
      throw new Error(`Expected route param "${name}" to be present.`);
    }

    return value;
  }

  collect(key?: string): Collection<any> {
    if (key === undefined) {
      return Collection.make(Object.values(this.inputBag));
    }

    const value = this.inputBag[key];

    if (Array.isArray(value)) {
      return Collection.make(value);
    }

    if (value && typeof value === "object") {
      return Collection.make(Object.values(value as Record<string, unknown>));
    }

    return Collection.make(value === undefined ? [] : [value]);
  }

  file(key: string): File | undefined {
    const value = this.fileBag[key];

    if (Array.isArray(value)) {
      return value[0];
    }

    return value;
  }

  files(key: string): File[] {
    const value = this.fileBag[key];

    if (value === undefined) {
      return [];
    }

    return Array.isArray(value) ? value : [value];
  }

  hasFile(key: string): boolean {
    return this.fileBag[key] !== undefined;
  }

  allFiles(): Record<string, File | File[]> {
    return { ...this.fileBag };
  }

  /**
   * Thin delegate to `Auth.userOrNull()` when `@mahiframework/auth` is bound,
   * else `undefined`. Not a second user-storage mechanism.
   */
  user<T = unknown>(): T | undefined {
    try {
      const auth = app().make<{ userOrNull: () => T | null }>("auth");

      return auth.userOrNull() ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Explicit route-model binding. The route param defaults to the model's
   * binding name (`Post` → `{post}`, via `Model.routeParamName()`); pass a
   * second argument to bind a differently-named param
   * (`request.model(User, "author")`). 404 if the param is missing or the
   * row doesn't exist. Cached on this instance so authorize + handle don't
   * double-fetch.
   *
   * Structural (not `typeof Model`) so concrete models with a typed `Row`
   * remain assignable, `Collection` variance otherwise rejects them.
   */
  async model<TInstance>(
    ModelClass: {
      table: string;
      find(id: string | number): Promise<TInstance | undefined>;
      routeParamName?(): string;
    },
    param?: string,
  ): Promise<TInstance> {
    type Resolved = TInstance;
    // Default the param name to the model's binding name (Post → "post"),
    // falling back to "id" for models that don't expose one.
    param ??= ModelClass.routeParamName?.() ?? "id";
    const cacheKey = `${ModelClass.table}:${param}`;

    if (this.modelCache.has(cacheKey)) {
      return this.modelCache.get(cacheKey) as Resolved;
    }

    const id = this.route(param);

    if (id === undefined) {
      throw HttpError.notFound();
    }

    const row = await ModelClass.find(id);

    if (row === undefined || row === null) {
      throw HttpError.notFound();
    }

    this.modelCache.set(cacheKey, row);

    return row as Resolved;
  }

  share(key: string, value: unknown): this {
    this.sharedBag.set(key, value);

    return this;
  }

  shared<T = unknown>(key: string): T | undefined {
    return this.sharedBag.get(key) as T | undefined;
  }

  /** Escape hatch to the underlying Hono context. */
  raw(): Context | undefined {
    return this.rawContext;
  }

  /**
   * Determine whether the current request is authorized. Offered as a
   * Laravel-style place to put authorization, but **not enforced**:
   * defaults to allow, so a Request that doesn't override it imposes no
   * gate. A class-based controller declaring this Request runs `authorize()`
   * before validation; returning `false` (or throwing `HttpError.forbidden()`)
   * yields a 403. Equally, you may ignore this and authorize inside the
   * controller's `handle()` (e.g. `authorize("delete", Post, model)`).
   */
  authorize(): boolean | void | Promise<boolean | void> {
    return true;
  }

  rules(): Record<string, import("@mahiframework/validation").Rule<any, any>> {
    return {};
  }

  prepareForValidation(): void | Promise<void> {
    // Override to mutate via merge() / mergeIfMissing() before rules run.
  }

  /**
   * Hook for a SECOND validation pass, run once `rules()` has passed and
   * `validated()` is readable (Laravel's `passedValidation()`). Does not
   * run when the field rules failed, there is nothing to validate
   * against yet.
   *
   * This is the extension point for a check whose schema is not known
   * until another field has been read, the case `rules()` structurally
   * cannot express:
   *
   *   override async passedValidation(): Promise<void> {
   *     const { driver_key, config } = this.validated();
   *     // throws ValidationException, keyed "config.*", on a bad field
   *     this.mergeValidated({ config: await driverFields(driver_key).check(config) });
   *   }
   *
   * Report failures by throwing `ValidationException`: its errors are
   * merged into this request's bag, so `validate()` returns `false`,
   * `errors()` reports them alongside any field errors, and
   * `validateOrFail()` (and therefore the controller pipeline) 422s. Any
   * other error propagates untouched, so a pass that needs to 403 or 404
   * can throw an `HttpError` instead.
   */
  passedValidation(): void | Promise<void> {
    // Override for a validation pass that depends on an already-validated field.
  }

  /**
   * Overlay `values` onto the validated payload, for a
   * `passedValidation()` pass that coerces or narrows a field it just
   * checked. A shallow assign, so a key not named is left as the rules
   * produced it.
   *
   * Throws when validation has not produced a payload: there is nothing
   * to merge into, and silently creating one would hand `validated()`
   * keys that were never checked.
   */
  mergeValidated(values: Record<string, unknown>): this {
    if (this.validatedPayload === undefined) {
      throw new Error("mergeValidated() was called before a successful validate().");
    }

    this.validatedPayload = { ...this.validatedPayload, ...values };

    return this;
  }

  /**
   * Run `prepareForValidation()` exactly once, whoever asks first.
   *
   * The controller pipeline calls this before `authorize()` (Laravel's
   * order), and `validate()` calls it too for the standalone
   * `request.validate()` path, so it has to be idempotent, or a request
   * that merges a counter or generates a value would do it twice.
   */
  async prepareInput(): Promise<void> {
    if (this.prepareRan) {
      return;
    }

    this.prepareRan = true;
    await this.prepareForValidation();
  }

  async validate(): Promise<boolean> {
    if (this.validateRan) {
      return Object.keys(this.errorBag).length === 0;
    }

    await this.prepareInput();
    const rules = this.rules();

    if (Object.keys(rules).length === 0) {
      this.validatedPayload = {};
      this.errorBag = {};
      this.validateRan = true;

      return await this.runPassedValidation();
    }

    const validator = new Validator(this.all(), this.allFiles(), rules);
    const passed = await validator.passes();
    this.errorBag = validator.errors();

    if (passed) {
      this.validatedPayload = validator.validated();
    }

    this.validateRan = true;

    return passed ? await this.runPassedValidation() : false;
  }

  /**
   * Run `passedValidation()`, folding a `ValidationException` it throws
   * into this request's error bag.
   *
   * Caught rather than propagated because `validate()` reports failure as
   * a `false` return, not a throw: letting the second pass throw out of
   * it would make `fails()` itself throw, and would skip the memoized
   * error bag that `errors()` and `validateOrFail()` both read. The
   * exception becomes the same 422 one step later, from
   * `validateOrFail()`.
   *
   * Called after `validateRan` is set, so a `passedValidation()` that
   * reaches back through `validate()` (or `passes()`/`fails()`) hits the
   * memoized result instead of recursing.
   */
  private async runPassedValidation(): Promise<boolean> {
    try {
      await this.passedValidation();
    } catch (error) {
      if (!(error instanceof ValidationException)) {
        throw error;
      }

      for (const [field, messages] of Object.entries(error.errors)) {
        this.errorBag[field] = [...(this.errorBag[field] ?? []), ...messages];
      }

      // The payload was built from rules that passed, but the request as
      // a whole did not. Dropping it keeps `validated()`'s guarantee:
      // what it hands back has been fully checked.
      this.validatedPayload = undefined;

      return false;
    }

    return true;
  }

  async passes(): Promise<boolean> {
    return this.validate();
  }

  async fails(): Promise<boolean> {
    return !(await this.validate());
  }

  async validateOrFail(): Promise<this> {
    if (!(await this.validate())) {
      throw new ValidationException(this.errors());
    }

    return this;
  }

  /**
   * The validated payload, only the keys that had rules.
   *
   * A Request with NO rules returns `{}` rather than throwing. It used
   * to throw, which made the base `Request` unusable in a controller
   * typed against it: `handle()` could not call `validated()` without
   * first knowing whether the subclass happened to declare rules, and
   * the failure was a 500 at runtime rather than a type error. Empty
   * rules means nothing was validated, and `{}` says exactly that.
   *
   * Still throws when rules DO exist and validation has not run (or did
   * not pass), reading a payload that was never checked is the bug this
   * guard is for.
   */
  validated(): InferRules<RulesOf<this>> {
    if (this.validatedPayload === undefined) {
      if (Object.keys(this.rules()).length === 0) {
        return {} as InferRules<RulesOf<this>>;
      }

      throw new Error("validated() was called before a successful validate().");
    }

    return this.validatedPayload as InferRules<RulesOf<this>>;
  }

  errors(): Record<string, string[]> {
    return this.errorBag;
  }
}

function isFile(value: unknown): value is File {
  return typeof File !== "undefined" && value instanceof File;
}

/** The on-the-wire name a cookie prefix produces. */
function prefixedCookieName(name: string, prefix?: CookieOptions["prefix"]): string {
  if (prefix === "host") {
    return `__Host-${name}`;
  }

  if (prefix === "secure") {
    return `__Secure-${name}`;
  }

  return name;
}

/**
 * What makes two queued cookies "the same cookie" for de-duplication.
 *
 * Browsers key a cookie on name + domain + path, so those three, and not
 * the name alone, decide whether a second `queueCookie()` replaces the
 * first or sits alongside it. An app legitimately sets `session` on two
 * paths; it never wants two `Set-Cookie`s for the same path.
 */
function cookieIdentity(name: string, options: CookieOptions): string {
  return [
    prefixedCookieName(name, options.prefix),
    options.domain ?? "",
    options.prefix === "host" ? "/" : (options.path ?? "/"),
  ].join("\u0000");
}

function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = value;
  }

  return result;
}

function headerRecord(c: Context): Record<string, string> {
  const result: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });

  return result;
}

function queryFromPath(path: string): Record<string, unknown> {
  const q = path.split("?")[1];

  if (!q) {
    return {};
  }

  return parseNestedQuery(q);
}

/**
 * Flatten a (possibly nested) query bag back into `[key, value]` pairs in
 * bracket notation, the inverse of `parseNestedQuery`. Used to rebuild
 * `fullUrl()` so that what goes out matches what came in.
 */
function flattenToPairs(bag: Record<string, unknown>, prefix = ""): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];

  for (const [key, value] of Object.entries(bag)) {
    const name = prefix ? `${prefix}[${key}]` : key;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== null && typeof item === "object") {
          pairs.push(...flattenToPairs(item as Record<string, unknown>, `${name}[]`));
        } else {
          pairs.push([`${name}[]`, String(item)]);
        }
      }
    } else if (value !== null && typeof value === "object") {
      pairs.push(...flattenToPairs(value as Record<string, unknown>, name));
    } else if (value !== undefined) {
      pairs.push([name, String(value)]);
    }
  }

  return pairs;
}

/**
 * Translate Hono's `:param` route pattern back into this framework's
 * `{param}` form, so `routePattern()` reads the same as what the app
 * wrote in `router.get(...)`.
 */
function honoPathToBraces(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)(\?)?/g, (_all, name: string, optional?: string) =>
    optional ? `{${name}?}` : `{${name}}`,
  );
}

export async function requestFromContext(c: Context): Promise<Request> {
  const existing = c.get(REQUEST_CONTEXT_KEY) as Request | undefined;

  if (existing) {
    existing.syncRouteParams(c);

    return existing;
  }

  return Request.from(c);
}
