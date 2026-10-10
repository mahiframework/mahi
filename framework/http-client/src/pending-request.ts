import { assertSafeUrl, retry } from "@mahiframework/core";
import { Pipeline, type PipeFn } from "@mahiframework/pipeline";
import { ClientRequest, type ClientRequestBody } from "./client-request.js";
import { makeClientResponse, type ClientResponse } from "./client-response.js";
import { ConnectionError, RequestFailedError, TooManyRedirectsError } from "./errors.js";
import { ConnectionFailed, RequestSending, ResponseReceived, type EventSink } from "./events.js";
import { buildMultipart, type Attachment, type AttachmentContents } from "./multipart.js";
import {
  DEFAULT_MAX_REDIRECTS,
  nextHop,
  redirectTarget,
  type SafeRedirectOptions,
} from "./safe-redirects.js";
import { fetchTransport, type Transport } from "./transport.js";
import { encodeNested } from "./query-encoder.js";
import { appendQuery, expandUrlTemplate, resolveUrl } from "./url-template.js";
import { writeToSink, type Sink } from "./sink.js";

/** How the request payload is serialized, and what `Content-Type` that implies. */
export type BodyFormat = "json" | "form" | "multipart" | "raw";

/** Per-send overrides for the low-level `send()` verb. */
export interface SendOptions {
  /** The payload, serialized per the configured body format. */
  data?: unknown;
  /** Query parameters appended to the URL. */
  query?: Record<string, unknown>;
}

/** The retry configuration `retry()` records. */
interface RetryOptions {
  times: number;
  sleepMs: number | readonly number[] | ((attempt: number, error: unknown) => number);
  when?: (error: unknown, response?: ClientResponse) => boolean;
}

/**
 * The complete immutable state of a `PendingRequest`. Held as one frozen
 * record so a copy is a spread rather than 20 field assignments, and so
 * adding an option can't silently miss a copy site.
 */
interface RequestOptions {
  baseUrl?: string;
  headers: Readonly<Record<string, string>>;
  /** Multi-value headers from `appendHeader()`, kept separate so `withHeaders()` can replace cleanly. */
  appendedHeaders: ReadonlyArray<readonly [string, string]>;
  bodyFormat: BodyFormat;
  contentType?: string;
  rawBody?: string | Uint8Array | ReadableStream<Uint8Array>;
  attachments: readonly Attachment[];
  urlParameters: Readonly<Record<string, string | number>>;
  queryParameters: Readonly<Record<string, unknown>>;
  timeoutMs?: number;
  redirect?: NonNullable<RequestInit["redirect"]>;
  safeRedirects?: SafeRedirectOptions;
  cookies: Readonly<Record<string, string>>;
  sink?: Sink;
  streamed: boolean;
  fetchOptions: Readonly<RequestInit & Record<string, unknown>>;
  middleware: ReadonlyArray<PipeFn<ClientRequest, ClientResponse>>;
  retry?: RetryOptions;
  throwOnFailure: boolean;
  throwCallback?: (response: ClientResponse, error: RequestFailedError) => void;
  throwCondition?: (response: ClientResponse) => boolean;
  dump: boolean;
  transport: Transport;
  events?: EventSink;
  observer?: SendObserver;
}

/**
 * Hooks the factory uses to record exchanges and to convert a synthesised
 * stray response into a `StrayRequestError`. Structural, so
 * `PendingRequest` has no dependency on `HttpClientFactory`.
 */
export interface SendObserver {
  /** Called once per `send()`, whatever the outcome. */
  record(request: ClientRequest, response: ClientResponse | undefined): void;
  /** Last chance to reject a response before the caller sees it. */
  inspect(response: ClientResponse): ClientResponse;
}

const defaultOptions: RequestOptions = {
  headers: {},
  appendedHeaders: [],
  bodyFormat: "json",
  attachments: [],
  urlParameters: {},
  queryParameters: {},
  cookies: {},
  streamed: false,
  fetchOptions: {},
  middleware: [],
  throwOnFailure: false,
  dump: false,
  transport: fetchTransport,
};

/**
 * Sentinel that converts a failed *response* into a thrown error so
 * `@mahiframework/core`'s exception-driven `retry()` can drive HTTP retries. A
 * failed status is an ordinary return value here, which is the whole point
 * of `throw()` being opt-in.
 *
 * Private to this module and always unwrapped before a caller can observe
 * it. Laravel bridges the same gap by calling `$response->throw()`
 * mid-flight and threading a `$shouldRetry` flag through a closure; this is
 * the same idea without the flag.
 */
class RetrySignal extends Error {
  constructor(readonly response: ClientResponse) {
    super("retryable response");
    this.name = "RetrySignal";
  }
}

/**
 * The fluent request builder, port of Laravel's
 * `Illuminate\Http\Client\PendingRequest`.
 *
 * **Immutable**: every method below returns a *new* `PendingRequest`
 * sharing a frozen options record. Laravel mutates `$this` on send (it
 * nulls `pendingBody`/`pendingFiles` and assigns `request`/`cookies`/
 * `transferStats` onto the instance), which makes a configured client
 * unsafe to hold and reuse, and holding one is the entire point of
 * `baseUrl()`. Copy-on-write fixes that, and makes concurrent sends from
 * one client safe without extra work.
 *
 *   const github = Http.baseUrl("https://api.github.com").withToken(token);
 *   const [user, repos] = await Promise.all([github.get("/user"), github.get("/repos")]);
 */
export class PendingRequest {
  private readonly options: RequestOptions;

  constructor(options: Partial<RequestOptions> = {}) {
    this.options = Object.freeze({ ...defaultOptions, ...options });
  }

  /** A copy with `overrides` applied. The single copy-on-write site. */
  private with(overrides: Partial<RequestOptions>): PendingRequest {
    return new PendingRequest({ ...this.options, ...overrides });
  }

  /** Serialize the payload as JSON (the default). */
  asJson(): PendingRequest {
    return this.bodyFormat("json");
  }

  /** Serialize the payload as `application/x-www-form-urlencoded`. */
  asForm(): PendingRequest {
    return this.bodyFormat("form");
  }

  /** Serialize the payload as `multipart/form-data`. Implied by `attach()`. */
  asMultipart(): PendingRequest {
    return this.bodyFormat("multipart");
  }

  bodyFormat(format: BodyFormat): PendingRequest {
    return this.with({ bodyFormat: format });
  }

  /** Set the `Content-Type` header explicitly, overriding the format's default. */
  contentType(type: string): PendingRequest {
    return this.with({ contentType: type });
  }

  /**
   * Send `content` verbatim as the body, bypassing payload serialization.
   * A `ReadableStream` streams. `duplex: "half"` is set for you.
   */
  withBody(
    content: string | Uint8Array | ReadableStream<Uint8Array>,
    contentType?: string,
  ): PendingRequest {
    return this.with({
      rawBody: content,
      bodyFormat: "raw",
      contentType: contentType ?? this.options.contentType,
    });
  }

  /**
   * Attach a file, forcing `multipart/form-data`. The boundary
   * `Content-Type` is generated by `fetch` at send time.
   */
  attach(
    name: string,
    contents: AttachmentContents,
    filename?: string,
    headers?: Record<string, string>,
  ): PendingRequest {
    return this.with({
      attachments: [...this.options.attachments, { name, contents, filename, headers }],
      bodyFormat: "multipart",
    });
  }

  /** Set `Authorization: <type> <token>`, defaulting to `Bearer`. */
  withToken(token: string, type = "Bearer"): PendingRequest {
    return this.withHeader("Authorization", `${type} ${token}`);
  }

  /**
   * Set a base64 `Authorization: Basic` header. Digest and NTLM are not
   * ported. They need a challenge-response round trip, which is a
   * middleware, not a header.
   */
  withBasicAuth(username: string, password: string): PendingRequest {
    const encoded = Buffer.from(`${username}:${password}`).toString("base64");

    return this.withHeader("Authorization", `Basic ${encoded}`);
  }

  /**
   * Merge `headers` over the existing ones, **replacing** on collision.
   *
   * Laravel uses `array_merge_recursive` here, so
   * `withHeaders({X:'1'}).withHeaders({X:'2'})` yields `X: ['1','2']`, a
   * bug people trip over, and the only reason its `replaceHeaders()`
   * exists. Replacing is what everyone expects; `appendHeader()` covers
   * the rare genuine multi-value case.
   */
  withHeaders(headers: Record<string, string>): PendingRequest {
    return this.with({ headers: { ...this.options.headers, ...headers } });
  }

  withHeader(name: string, value: string): PendingRequest {
    return this.withHeaders({ [name]: value });
  }

  /** Add another value for `name`, keeping any already set. */
  appendHeader(name: string, value: string): PendingRequest {
    return this.with({
      appendedHeaders: [...this.options.appendedHeaders, [name, value] as const],
    });
  }

  accept(contentType: string): PendingRequest {
    return this.withHeader("Accept", contentType);
  }

  acceptJson(): PendingRequest {
    return this.accept("application/json");
  }

  withUserAgent(userAgent: string): PendingRequest {
    return this.withHeader("User-Agent", userAgent);
  }

  /** Prefix for relative paths. An absolute request URL ignores it. */
  baseUrl(url: string): PendingRequest {
    return this.with({ baseUrl: url });
  }

  /** Values for `{placeholder}` segments in the URL. */
  withUrlParameters(params: Record<string, string | number>): PendingRequest {
    return this.with({ urlParameters: { ...this.options.urlParameters, ...params } });
  }

  /** Query parameters, merged with any already on the URL. */
  withQueryParameters(params: Record<string, unknown>): PendingRequest {
    return this.with({ queryParameters: { ...this.options.queryParameters, ...params } });
  }

  /**
   * Abort the request after `ms`. Covers the **whole** exchange. `fetch`
   * has no separate connect timeout, so Laravel's `connectTimeout()` has
   * no equivalent and is not ported.
   */
  timeout(ms: number): PendingRequest {
    return this.with({ timeoutMs: ms });
  }

  /** Return the 3xx instead of following it (`redirect: "manual"`). */
  withoutRedirecting(): PendingRequest {
    return this.with({ redirect: "manual" });
  }

  /**
   * Follow redirects, validating the target of **every hop** against a
   * `UrlPolicy` before it is requested.
   *
   *   Http.withSafeRedirects({ maxRedirects: 3 }).get(url);
   *   Http.withSafeRedirects({ allowPrivate: true }).get(url);
   *
   * This is the piece an application cannot write for itself. `fetch`
   * follows the whole chain inside one call and exposes only the final
   * URL (`response.url`) and the fact that it happened
   * (`response.redirected`) — the intermediate hops are not observable,
   * so a request middleware sees one request and a public URL that
   * redirects to `127.0.0.1` reaches it unchecked. The only way to see
   * each hop is to drive the chain with `redirect: "manual"`, and doing
   * that correctly means reimplementing 303 method rewriting, 307/308
   * body replay, cross-host credential stripping and a hop cap. That is
   * this package's job, not every app's.
   *
   * The FIRST request is validated too, so a direct
   * `http://169.254.169.254/` is refused without a redirect being
   * involved.
   *
   * 🚨 VALIDATION IS BY NAME AND SO IS RACY. `assertSafeUrl()` resolves
   * the host; the transport then resolves it again, and a name can
   * answer differently the second time. See that function's docstring.
   * Pinning resolution needs a custom dispatcher, which this package has
   * no dependency to build.
   *
   * Overrides `withoutRedirecting()`: following every hop and following
   * none are not combinable, and the explicit safety request wins.
   * Raises `UnsafeUrlError` for a rejected hop and
   * `TooManyRedirectsError` past the cap.
   */
  withSafeRedirects(options: SafeRedirectOptions = {}): PendingRequest {
    return this.with({ safeRedirects: options });
  }

  /**
   * Set a `Cookie` header. There is no jar: `fetch` does not persist
   * cookies across requests, and this does not add one. Read the
   * response's via `response.cookies()`.
   */
  withCookies(cookies: Record<string, string>): PendingRequest {
    return this.with({ cookies: { ...this.options.cookies, ...cookies } });
  }

  /**
   * Write the response body to a file path or `WritableStream` as it
   * arrives, instead of holding it in memory. `body()` stays readable for
   * a stubbed response, and is empty for a real one.
   */
  sink(to: Sink): PendingRequest {
    return this.with({ sink: to });
  }

  /**
   * Skip buffering the response body, `response.stream()` gives the raw
   * `ReadableStream`, and `body()`/`json()` throw. Laravel has no
   * first-class equivalent (it's `withOptions(['stream' => true])`).
   */
  stream(): PendingRequest {
    return this.with({ streamed: true });
  }

  /**
   * Merge raw `RequestInit` over everything this builder produced, the
   * analogue of dropping Guzzle options straight in, and the escape hatch
   * for anything `fetch` supports that this class doesn't wrap.
   *
   * Proxies and TLS options live here, via undici's non-standard
   * `dispatcher` key:
   *
   *   .withFetchOptions({ dispatcher: new ProxyAgent(url) })
   *
   * That requires `undici` as the **application's** dependency, not this
   * package's, hence the untyped `Record<string, unknown>` half.
   */
  withFetchOptions(init: RequestInit & Record<string, unknown>): PendingRequest {
    return this.with({ fetchOptions: { ...this.options.fetchOptions, ...init } });
  }

  /** Swap the transport, the seam fakes, mocks, and proxies hook into. */
  withTransport(transport: Transport): PendingRequest {
    return this.with({ transport });
  }

  /** Wire an event dispatcher. Set by `HttpClientServiceProvider`; no-op otherwise. */
  withEvents(events: EventSink | undefined): PendingRequest {
    return this.with({ events });
  }

  /** Wire the factory's recording/stray hooks. Internal; set by `HttpClientFactory`. */
  withObserver(observer: SendObserver | undefined): PendingRequest {
    return this.with({ observer });
  }

  /**
   * Add a `@mahiframework/pipeline` pipe seeing the request on the way down and the
   * response on the way back. One mechanism covering Laravel's
   * `withMiddleware` + `beforeSending` + `afterResponse`.
   *
   *   .withMiddleware(async (req, next) => {
   *     const res = await next(req.withHeader("X-Trace", id));
   *     log(res.status);
   *     return res;
   *   })
   */
  withMiddleware(pipe: PipeFn<ClientRequest, ClientResponse>): PendingRequest {
    return this.with({ middleware: [...this.options.middleware, pipe] });
  }

  /** Shorthand for a pipe that only transforms the outgoing request. */
  withRequestMiddleware(
    fn: (request: ClientRequest) => ClientRequest | Promise<ClientRequest>,
  ): PendingRequest {
    return this.withMiddleware(async (request, next) => next(await fn(request)));
  }

  /** Shorthand for a pipe that only transforms the incoming response. */
  withResponseMiddleware(
    fn: (response: ClientResponse) => ClientResponse | Promise<ClientResponse>,
  ): PendingRequest {
    return this.withMiddleware(async (request, next) => fn(await next(request)));
  }

  /**
   * Retry up to `times` attempts (the first counts). `sleepMs` is a fixed
   * delay, an array of per-attempt delays, or a function of the attempt.
   *
   * **Everything that failed is retryable by default**, any 4xx or 5xx,
   * including 401 and 422, plus `ConnectionError`. That is Laravel's
   * behaviour, and matching it is the point of a port: a status-based
   * allow-list would silently break the genuinely-retryable cases (a 401
   * where middleware refreshes the token between attempts; a 409 against
   * an optimistic-locking API), and would look like the framework ignoring
   * your `retry(3)`.
   *
   * To narrow it, "retry only 5xx" being the common intent:
   *
   *   .retry(3, 100, (error, response) =>
   *     error instanceof ConnectionError || (response?.serverError() ?? false))
   *
   * A `Retry-After` header on a 429/503 overrides `sleepMs` (capped at
   * 60s). Laravel ignores it, which is the single most common reason a
   * retrying client gets rate-limit-banned.
   *
   * On exhaustion the final failed response is **returned**, not thrown,
   * `throw()` still governs raising, so Laravel's `throw` flag is not
   * needed.
   */
  retry(
    times: number,
    sleepMs: number | readonly number[] | ((attempt: number, error: unknown) => number) = 0,
    when?: (error: unknown, response?: ClientResponse) => boolean,
  ): PendingRequest {
    return this.with({ retry: { times, sleepMs, when } });
  }

  /** Raise `RequestFailedError` if the response failed. */
  throw(callback?: (response: ClientResponse, error: RequestFailedError) => void): PendingRequest {
    return this.with({ throwOnFailure: true, throwCallback: callback, throwCondition: undefined });
  }

  /**
   * Raise on failure only when `condition` holds.
   *
   * Takes a real predicate. Laravel's `throwIf` has the wart that a
   * callable condition is itself truthy, so `throwIf($closure)` always
   * arms *and* stores the closure; there is no such overloaded second
   * meaning here.
   */
  throwIf(condition: boolean | ((response: ClientResponse) => boolean)): PendingRequest {
    return this.with({
      throwOnFailure: true,
      throwCondition: typeof condition === "function" ? condition : () => condition,
    });
  }

  /** Raise on failure unless `condition` holds. */
  throwUnless(condition: boolean | ((response: ClientResponse) => boolean)): PendingRequest {
    const predicate = typeof condition === "function" ? condition : () => condition;

    return this.with({ throwOnFailure: true, throwCondition: (response) => !predicate(response) });
  }

  /**
   * `console.dir` the outgoing request before sending. Laravel's `dd()` is
   * not ported: it calls `exit(1)`, which in a Node test runner kills the
   * whole suite.
   */
  dump(): PendingRequest {
    return this.with({ dump: true });
  }

  get(url: string, query?: Record<string, unknown>): Promise<ClientResponse> {
    return this.send("GET", url, { query });
  }

  head(url: string, query?: Record<string, unknown>): Promise<ClientResponse> {
    return this.send("HEAD", url, { query });
  }

  post(url: string, data?: unknown): Promise<ClientResponse> {
    return this.send("POST", url, { data });
  }

  put(url: string, data?: unknown): Promise<ClientResponse> {
    return this.send("PUT", url, { data });
  }

  patch(url: string, data?: unknown): Promise<ClientResponse> {
    return this.send("PATCH", url, { data });
  }

  delete(url: string, data?: unknown): Promise<ClientResponse> {
    return this.send("DELETE", url, { data });
  }

  /**
   * The low-level verb every other one funnels through. Resolves even for
   * a 4xx/5xx; rejects only on transport failure (`ConnectionError`) or a
   * stray request while faking (`StrayRequestError`).
   */
  async send(method: string, url: string, options: SendOptions = {}): Promise<ClientResponse> {
    const request = await this.buildRequest(method, url, options);

    if (this.options.dump) {
      console.dir(
        {
          method: request.method,
          url: request.url,
          headers: request.headers(),
          body: request.body(),
          data: request.data(),
        },
        { depth: null },
      );
    }

    const response = await this.dispatchWithRetries(request);

    // The stray check runs before `throw()`: a missing stub is a harness
    // failure, not an HTTP failure the caller opted into handling.
    const { observer } = this.options;

    return this.applyThrow(observer ? observer.inspect(response) : response);
  }

  /** Assembles the URL, headers, and serialized body into a `ClientRequest`. */
  private async buildRequest(
    method: string,
    url: string,
    options: SendOptions,
  ): Promise<ClientRequest> {
    const resolved = appendQuery(
      expandUrlTemplate(resolveUrl(this.options.baseUrl, url), this.options.urlParameters),
      { ...this.options.queryParameters, ...(options.query ?? {}) },
    );

    const headers = new Headers(this.options.headers);

    for (const [name, value] of this.options.appendedHeaders) {
      headers.append(name, value);
    }

    const cookieEntries = Object.entries(this.options.cookies);

    if (cookieEntries.length > 0) {
      headers.set(
        "cookie",
        cookieEntries.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; "),
      );
    }

    const { body, contentType } = await this.buildBody(method, options.data);
    // An explicit contentType() always wins; the format's implied type only
    // fills a gap. Multipart deliberately sets neither, `fetch` generates
    // the boundary-bearing header itself.
    const explicit = this.options.contentType;

    if (explicit !== undefined) {
      headers.set("content-type", explicit);
    } else if (contentType !== undefined && !headers.has("content-type")) {
      headers.set("content-type", contentType);
    }

    return new ClientRequest({
      method,
      url: resolved,
      headers,
      body,
      data: options.data,
      fetchOptions: this.options.fetchOptions,
    });
  }

  /** Serializes the payload according to the configured body format. */
  private async buildBody(
    method: string,
    data: unknown,
  ): Promise<{ body: ClientRequestBody; contentType?: string }> {
    if (this.options.bodyFormat === "multipart" || this.options.attachments.length > 0) {
      return { body: await buildMultipart(data, this.options.attachments) };
    }

    if (this.options.rawBody !== undefined) {
      return { body: this.options.rawBody };
    }

    if (data === undefined || data === null) {
      return { body: undefined };
    }

    if (this.options.bodyFormat === "form") {
      const search = new URLSearchParams();

      // Bracket-nesting so `{ a: { b: 1 } }` becomes `a[b]=1` rather than
      // the `a=[object Object]` a bare `String(value)` produced.
      for (const [key, value] of encodeNested(data as Record<string, unknown>)) {
        search.append(key, value);
      }

      return { body: search.toString(), contentType: "application/x-www-form-urlencoded" };
    }

    if (this.options.bodyFormat === "raw") {
      return { body: typeof data === "string" ? data : String(data) };
    }

    // GET/HEAD carry no body; a payload there becomes query parameters
    // upstream, not a body fetch would reject.
    if (method === "GET" || method === "HEAD") {
      return { body: undefined };
    }

    return { body: JSON.stringify(data), contentType: "application/json" };
  }

  /**
   * Wraps the whole pipeline in `@mahiframework/core`'s `retry()`, bridging failed
   * responses into it via `RetrySignal`. Middleware therefore re-runs and
   * `RequestSending` re-fires per attempt, matching Laravel.
   */
  private async dispatchWithRetries(request: ClientRequest): Promise<ClientResponse> {
    const config = this.options.retry;

    if (!config) {
      return this.runPipeline(request);
    }

    // A `ReadableStream` body is consumed by the first attempt and cannot be
    // re-sent, a second `toFetchRequest()` would reject with the opaque
    // "Response body object should not be disturbed or locked", which the
    // transport catch then mislabels as a `ConnectionError` and retries
    // again. Refuse up front with a message that names the actual problem.
    // Buffer the body yourself (or use a string/Uint8Array) if you need
    // retries.
    if (config.times > 1 && request.rawBody() instanceof ReadableStream) {
      throw new ConnectionError(
        `Cannot retry ${request.method} ${request.url}: its body is a ReadableStream, which can ` +
          `only be sent once. Buffer the body (pass a string or Uint8Array) if the request needs retries.`,
        request,
      );
    }

    try {
      return await retry(
        config.times,
        async () => {
          const response = await this.runPipeline(request);

          if (response.failed()) {
            throw new RetrySignal(response);
          }

          return response;
        },
        (attempt, error) => {
          const retryAfter =
            error instanceof RetrySignal ? retryAfterDelay(error.response) : undefined;

          if (retryAfter !== undefined) {
            return retryAfter;
          }

          const { sleepMs } = config;

          if (typeof sleepMs === "function") {
            return sleepMs(attempt, error);
          }

          if (typeof sleepMs === "number") {
            return sleepMs;
          }

          return sleepMs[attempt - 1] ?? sleepMs.at(-1) ?? 0;
        },
        (error) => {
          if (!config.when) {
            return true;
          }

          // The callback throws on *any* failure and lets `when` decide,
          // rather than pre-filtering, so a user predicate sees every
          // failed attempt and a ConnectionError through one path. The
          // sentinel itself is never handed over: a failed response is
          // `(undefined, response)`, a transport failure `(error, undefined)`.
          return error instanceof RetrySignal
            ? config.when(undefined, error.response)
            : config.when(error, undefined);
        },
      );
    } catch (error) {
      // Exhaustion rethrows the last error. A RetrySignal unwraps back to
      // its response, so a retried-to-exhaustion request returns the final
      // failed response like any other, and the sentinel never escapes.
      if (error instanceof RetrySignal) {
        return error.response;
      }

      throw error;
    }
  }

  /** Runs the middleware stack with the transport as its destination. */
  private runPipeline(request: ClientRequest): Promise<ClientResponse> {
    return new Pipeline<ClientRequest, ClientResponse>()
      .send(request)
      .through([...this.options.middleware])
      .run((finalRequest) => this.dispatch(finalRequest));
  }

  /**
   * The innermost step: hand the request to the transport, following
   * redirects by hand when `withSafeRedirects()` asked for it.
   */
  private dispatch(request: ClientRequest): Promise<ClientResponse> {
    return this.options.safeRedirects === undefined
      ? this.dispatchOnce(request)
      : this.dispatchChain(request, this.options.safeRedirects);
  }

  /**
   * Drive the redirect chain one hop at a time, validating each target
   * before it is requested.
   *
   * `redirect: "manual"` is forced, because seeing each `Location`
   * before the next request goes out is the entire point — `fetch`
   * following the chain internally is exactly what makes per-hop
   * validation impossible. See `withSafeRedirects()`.
   *
   * A redirect's own body is DISCARDED rather than buffered, streamed or
   * written to a `sink()`: "302, go here" is not the response the caller
   * asked for, and draining it into a sink would leave the file holding
   * the wrong bytes. Only the terminal hop produces a `ClientResponse`
   * the caller sees.
   *
   * Each hop is recorded and fires its own events, since each is a real
   * request and `assertSentCount()` means "how many went out".
   */
  private async dispatchChain(
    request: ClientRequest,
    policy: SafeRedirectOptions,
  ): Promise<ClientResponse> {
    const cap = policy.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const visited: string[] = [];
    let current = request;

    for (let hop = 0; ; hop++) {
      // The FIRST request is validated too: a direct call to a metadata
      // address is the same problem as a redirect to one.
      await assertSafeUrl(current.url, policy);
      visited.push(current.url);

      const { raw, durationMs } = await this.callTransport(current, "manual");
      const target = redirectTarget(raw, current.url);

      if (target === undefined) {
        return this.wrapResponse(raw, current, durationMs);
      }

      // The redirect's body is of no interest and holds a connection
      // open until it is read.
      await raw.body?.cancel();
      this.options.observer?.record(current, undefined);

      if (hop >= cap) {
        throw new TooManyRedirectsError(current, [...visited, target], cap);
      }

      const next = nextHop(current, raw.status, target);

      // The stream was consumed by the hop that just went out, so a
      // 307/308 replay would reject with the opaque "body object should
      // not be disturbed or locked". Say what the problem actually is.
      if (next.rawBody() instanceof ReadableStream) {
        throw new ConnectionError(
          `Cannot follow the ${raw.status} from ${current.url}: the request body is a ` +
            `ReadableStream, which can only be sent once, and a ${raw.status} replays it. ` +
            `Buffer the body (pass a string or Uint8Array) if the request may be redirected.`,
          current,
        );
      }

      current = next;
    }
  }

  /** One request, one response. The transport boundary. */
  private async dispatchOnce(request: ClientRequest): Promise<ClientResponse> {
    const { raw, durationMs } = await this.callTransport(request);

    return this.wrapResponse(raw, request, durationMs);
  }

  /**
   * Hand one request to the transport and time it.
   *
   * Split from `wrapResponse()` so the redirect chain can read a hop's
   * status and `Location` and then discard its body, which buffering it
   * into a `ClientResponse` would have already consumed.
   */
  private async callTransport(
    request: ClientRequest,
    redirect?: NonNullable<RequestInit["redirect"]>,
  ): Promise<{ raw: Response; durationMs: number }> {
    const init: RequestInit & Record<string, unknown> = { ...this.options.fetchOptions };
    const mode = redirect ?? this.options.redirect;

    if (mode !== undefined) {
      init.redirect = mode;
    }

    if (this.options.timeoutMs !== undefined) {
      // Compose the timeout with any caller-supplied signal rather than
      // dropping it: `timeout()` and a cancellation `signal` are orthogonal
      // concerns, and honouring only whichever was set last is a foot-gun.
      // `AbortSignal.any()` aborts as soon as either fires.
      const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs);
      init.signal =
        init.signal instanceof AbortSignal
          ? AbortSignal.any([init.signal, timeoutSignal])
          : timeoutSignal;
    }

    this.options.events?.dispatch(new RequestSending(request));

    const startedAt = Date.now();

    try {
      const raw = await this.options.transport(request.toFetchRequest(init), init);

      return { raw, durationMs: Date.now() - startedAt };
    } catch (error) {
      const failure = new ConnectionError(connectionMessage(error, request), request, {
        cause: error,
      });
      // Recorded before the throw, so a request that never got an answer
      // still appears in `recorded()`/`assertSent()`.
      this.options.observer?.record(request, undefined);
      this.options.events?.dispatch(new ConnectionFailed(request, failure));
      throw failure;
    }
  }

  /** Buffer, sink or stream a transport response, and record it. */
  private async wrapResponse(
    raw: Response,
    request: ClientRequest,
    durationMs: number,
  ): Promise<ClientResponse> {
    let buffered: Uint8Array | undefined;

    if (this.options.sink !== undefined) {
      buffered = await writeToSink(raw, this.options.sink);
    }

    const response = await makeClientResponse(raw, request, durationMs, {
      streamed: this.options.streamed && this.options.sink === undefined,
      buffered,
    });

    // Recorded here, at the transport boundary, rather than once per
    // `send()`: a retried request makes several real calls, and
    // `assertSentCount()` means "how many requests actually went out".
    // Matches Laravel, where each attempt is recorded separately.
    this.options.observer?.record(request, response);
    this.options.events?.dispatch(new ResponseReceived(request, response));

    return response;
  }

  /** Applies the `throw()`/`throwIf()`/`throwUnless()` configuration. */
  private applyThrow(response: ClientResponse): ClientResponse {
    if (!this.options.throwOnFailure) {
      return response;
    }

    if (this.options.throwCondition && !this.options.throwCondition(response)) {
      return response;
    }

    return response.throw(this.options.throwCallback);
  }
}

/**
 * The delay a server asked for via `Retry-After` on a 429/503, in
 * milliseconds, delta-seconds or an HTTP-date, capped at 60s so a hostile
 * or mistaken header can't stall a test suite. `undefined` when absent or
 * unparseable, in which case the configured backoff applies.
 */
function retryAfterDelay(response: ClientResponse): number | undefined {
  if (response.status !== 429 && response.status !== 503) {
    return undefined;
  }

  const header = response.header("retry-after");

  if (header === undefined) {
    return undefined;
  }

  // An empty or whitespace-only header is "no value", not zero: `Number("")`
  // and `Number("  ")` are both 0, which would override the configured
  // backoff with an immediate retry and turn a bare `Retry-After:` into a
  // hot retry storm against a server already signalling overload.
  const trimmed = header.trim();

  if (trimmed === "") {
    return undefined;
  }

  // delta-seconds only when the value is purely numeric; otherwise treat it
  // as an HTTP-date. (`Number("2xx")` is NaN, but a stray non-numeric
  // delta-seconds should fall through to date parsing, not be accepted.)
  const seconds = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(trimmed) - Date.now();

  if (!Number.isFinite(ms) || Number.isNaN(ms)) {
    return undefined;
  }

  return Math.min(Math.max(ms, 0), 60_000);
}

/** A readable message for a transport failure, which `fetch` reports opaquely. */
function connectionMessage(error: unknown, request: ClientRequest): string {
  const detail = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";

  return `Connection to ${request.method} ${request.url} failed (${detail}${cause}).`;
}
