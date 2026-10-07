import { pooled } from "@mahiframework/core";
import type { PipeFn } from "@mahiframework/pipeline";
import type { ClientRequest } from "./client-request.js";
import type { ClientResponse } from "./client-response.js";
import { HttpClientFactory, type RecordedPair } from "./http-client-factory.js";
import { urlMatch } from "./matching.js";
import type { AttachmentContents } from "./multipart.js";
import type { BodyFormat, PendingRequest } from "./pending-request.js";
import { ResponseSequence } from "./response-sequence.js";
import type { StubEntry, StubHandler, StubResponse, StubResponseSpec } from "./stub.js";
import type { Transport } from "./transport.js";

/** A matcher for the assertion helpers: a URL pattern, or a predicate. */
export type RequestMatcher =
  string | ((request: ClientRequest, response: ClientResponse | undefined) => boolean);

/**
 * The module-level factory backing the static surface, so
 * `import { Http } from "@mahiframework/http-client"` works in a plain script with
 * no container. `HttpClientServiceProvider` swaps it for a config-carrying
 * one where an application is present.
 */
let factory = new HttpClientFactory();

/**
 * `@mahiframework/http-client`'s entry point, a fluent, faketable outbound HTTP
 * client, port of Laravel's `Illuminate\Http\Client\Factory` (`Http::get()`,
 * `Http::fake()`, `Http::assertSent()`).
 *
 * Built on the platform `fetch`, not a third-party client: `undici` *is*
 * `fetch` on Node 26, and axios would make this a port of axios wearing
 * Laravel's method names. What that costs, no separate connect timeout,
 * no cookie jar, no digest auth, proxies via
 * `withFetchOptions({ dispatcher })`, is documented in the package guide.
 *
 * Static facade over module-level state, mirroring `@mahiframework/process`'s
 * `Process`: no container needed for the common case, and the fake state
 * lives somewhere a test's `afterEach` can reach.
 *
 * ```ts
 * import { Http } from "@mahiframework/http-client";
 *
 * const response = await Http.withToken(token).post("https://api.example.com/users", { name: "Ada" });
 * if (response.successful()) console.log(response.json<{ id: number }>().id);
 *
 * // In tests:
 * Http.fake({ "api.example.com/*": { id: 1 } });
 * await createUser();
 * Http.assertSent("api.example.com/users");
 * Http.restore();
 * ```
 *
 * Every non-assertion method here forwards to a `PendingRequest`, by hand,
 * the house rule for facades (see `@mahiframework/facades`' `Facade()`
 * docstring): no `Proxy`, no macros, every method with a real signature.
 */
export class Http {
  /** A fresh request builder carrying the factory's configured defaults. */
  static request(): PendingRequest {
    return factory.request();
  }

  /** A request builder preconfigured from `clients.<name>` in the config. */
  static client(name: string): PendingRequest {
    return factory.client(name);
  }

  static asJson(): PendingRequest {
    return factory.request().asJson();
  }

  static asForm(): PendingRequest {
    return factory.request().asForm();
  }

  static asMultipart(): PendingRequest {
    return factory.request().asMultipart();
  }

  static bodyFormat(format: BodyFormat): PendingRequest {
    return factory.request().bodyFormat(format);
  }

  static contentType(type: string): PendingRequest {
    return factory.request().contentType(type);
  }

  static withBody(
    content: string | Uint8Array | ReadableStream<Uint8Array>,
    contentType?: string,
  ): PendingRequest {
    return factory.request().withBody(content, contentType);
  }

  static attach(
    name: string,
    contents: AttachmentContents,
    filename?: string,
    headers?: Record<string, string>,
  ): PendingRequest {
    return factory.request().attach(name, contents, filename, headers);
  }

  static withToken(token: string, type?: string): PendingRequest {
    return factory.request().withToken(token, type);
  }

  static withBasicAuth(username: string, password: string): PendingRequest {
    return factory.request().withBasicAuth(username, password);
  }

  static withHeaders(headers: Record<string, string>): PendingRequest {
    return factory.request().withHeaders(headers);
  }

  static withHeader(name: string, value: string): PendingRequest {
    return factory.request().withHeader(name, value);
  }

  static appendHeader(name: string, value: string): PendingRequest {
    return factory.request().appendHeader(name, value);
  }

  static accept(contentType: string): PendingRequest {
    return factory.request().accept(contentType);
  }

  static acceptJson(): PendingRequest {
    return factory.request().acceptJson();
  }

  static withUserAgent(userAgent: string): PendingRequest {
    return factory.request().withUserAgent(userAgent);
  }

  static baseUrl(url: string): PendingRequest {
    return factory.request().baseUrl(url);
  }

  static withUrlParameters(params: Record<string, string | number>): PendingRequest {
    return factory.request().withUrlParameters(params);
  }

  static withQueryParameters(params: Record<string, unknown>): PendingRequest {
    return factory.request().withQueryParameters(params);
  }

  static timeout(ms: number): PendingRequest {
    return factory.request().timeout(ms);
  }

  static withoutRedirecting(): PendingRequest {
    return factory.request().withoutRedirecting();
  }

  static withCookies(cookies: Record<string, string>): PendingRequest {
    return factory.request().withCookies(cookies);
  }

  static sink(to: string | WritableStream<Uint8Array>): PendingRequest {
    return factory.request().sink(to);
  }

  static stream(): PendingRequest {
    return factory.request().stream();
  }

  static withFetchOptions(init: RequestInit & Record<string, unknown>): PendingRequest {
    return factory.request().withFetchOptions(init);
  }

  static withTransport(transport: Transport): PendingRequest {
    return factory.request().withTransport(transport);
  }

  static withMiddleware(pipe: PipeFn<ClientRequest, ClientResponse>): PendingRequest {
    return factory.request().withMiddleware(pipe);
  }

  static withRequestMiddleware(
    fn: (request: ClientRequest) => ClientRequest | Promise<ClientRequest>,
  ): PendingRequest {
    return factory.request().withRequestMiddleware(fn);
  }

  static withResponseMiddleware(
    fn: (response: ClientResponse) => ClientResponse | Promise<ClientResponse>,
  ): PendingRequest {
    return factory.request().withResponseMiddleware(fn);
  }

  static retry(
    times: number,
    sleepMs?: number | readonly number[] | ((attempt: number, error: unknown) => number),
    when?: (error: unknown, response?: ClientResponse) => boolean,
  ): PendingRequest {
    return factory.request().retry(times, sleepMs, when);
  }

  static throw(callback?: (response: ClientResponse, error: Error) => void): PendingRequest {
    return factory.request().throw(callback as never);
  }

  static throwIf(condition: boolean | ((response: ClientResponse) => boolean)): PendingRequest {
    return factory.request().throwIf(condition);
  }

  static throwUnless(condition: boolean | ((response: ClientResponse) => boolean)): PendingRequest {
    return factory.request().throwUnless(condition);
  }

  static dump(): PendingRequest {
    return factory.request().dump();
  }

  static get(url: string, query?: Record<string, unknown>): Promise<ClientResponse> {
    return factory.request().get(url, query);
  }

  static head(url: string, query?: Record<string, unknown>): Promise<ClientResponse> {
    return factory.request().head(url, query);
  }

  static post(url: string, data?: unknown): Promise<ClientResponse> {
    return factory.request().post(url, data);
  }

  static put(url: string, data?: unknown): Promise<ClientResponse> {
    return factory.request().put(url, data);
  }

  static patch(url: string, data?: unknown): Promise<ClientResponse> {
    return factory.request().patch(url, data);
  }

  static delete(url: string, data?: unknown): Promise<ClientResponse> {
    return factory.request().delete(url, data);
  }

  /**
   * Run several requests concurrently, keeping their keys and surfacing a
   * per-entry failure as an `Error` value rather than losing the other
   * results. A thin typed wrapper over `@mahiframework/core`'s `pooled()`, which is
   * where the mechanics live. Pooling has nothing to do with HTTP.
   *
   *   const { user, repos } = await Http.pool((http) => ({
   *     user: () => http.get("https://api.example.com/user"),
   *     repos: () => http.get("https://api.example.com/repos"),
   *   }), { concurrency: 2 });
   *
   * The callback receives a `PendingRequest` and returns **thunks**, not
   * promises: a promise is already running by the time you hold one, so an
   * array of them cannot be concurrency-limited. This is why no
   * `LazyPromise` machinery is needed here, unlike Laravel.
   */
  static pool<K extends string>(
    callback: (http: PendingRequest) => Record<K, () => Promise<ClientResponse>>,
    options?: { concurrency?: number },
  ): Promise<Record<K, ClientResponse | Error>>;
  static pool(
    callback: (http: PendingRequest) => Array<() => Promise<ClientResponse>>,
    options?: { concurrency?: number },
  ): Promise<Array<ClientResponse | Error>>;
  static pool(
    callback: (
      http: PendingRequest,
    ) => Array<() => Promise<ClientResponse>> | Record<string, () => Promise<ClientResponse>>,
    options: { concurrency?: number } = {},
  ): Promise<Array<ClientResponse | Error> | Record<string, ClientResponse | Error>> {
    const tasks = callback(factory.request());

    return Array.isArray(tasks) ? pooled(tasks, options) : pooled(tasks, options);
  }

  /**
   * Intercept every outbound request. Four forms:
   *
   *   Http.fake();                                   // everything → 200, empty body
   *   Http.fake((req) => ({ ok: true }));            // one handler for everything
   *   Http.fake({ "github.com/*": { id: 1 } });      // per-pattern stubs
   *   Http.fake({ "github.com/*": Http.sequence().pushStatus(500).push({ id: 1 }) });
   *
   * **A request matching no stub never reaches the network**. It raises
   * `StrayRequestError`. Laravel falls through to the real handler, so a
   * typo'd pattern silently makes a live call from your test suite; the
   * failure mode there is a slow, flaky, internet-dependent test rather
   * than an error. `allowStrayRequests()` opts back out.
   *
   * Replaces rather than accumulating: call it once with a full map.
   * Always pair with `Http.restore()` in an `afterEach`.
   */
  static fake(stubs?: Record<string, StubEntry> | StubHandler): void {
    factory.fake(stubs);
  }

  /** Build a stub response explicitly, for readability at a call site. */
  static response(
    body?: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ): StubResponseSpec {
    return { body, status, headers };
  }

  /** A FIFO queue of responses for one pattern, "fails twice, then succeeds". */
  static sequence(): ResponseSequence {
    return new ResponseSequence();
  }

  /** A stub handler that fails the transport, surfacing as `ConnectionError`. */
  static failedConnection(message = "Connection failed."): StubHandler {
    return () => {
      throw new Error(message);
    };
  }

  /**
   * Let unmatched requests reach the real network, Laravel's default,
   * which this package inverts. With `patterns`, only matching URLs are
   * allowed through. Allow-list patterns have **no** implicit leading `*`,
   * unlike stub patterns: an explicit escape is worth spelling out.
   *
   *   Http.allowStrayRequests();                  // all misses hit the network
   *   Http.allowStrayRequests(["*localhost*"]);   // only these do
   */
  static allowStrayRequests(only?: string[]): void {
    factory.allowStrayRequests(only);
  }

  /** True while `Http.fake()` is active. */
  static isFaked(): boolean {
    return factory.isFaked();
  }

  /** Clears stubs, recordings, and the stray guard. The `afterEach` hook. */
  static restore(): void {
    factory.restore();
  }

  /** Every recorded exchange, oldest first, optionally filtered. */
  static recorded(
    filter?: (request: ClientRequest, response: ClientResponse | undefined) => boolean,
  ): readonly RecordedPair[] {
    return factory.recorded(filter);
  }

  /** Asserts at least one request matched. */
  static assertSent(matcher: RequestMatcher): void {
    if (!Http.matches(matcher).length) {
      throw new Error(
        `Expected a request matching ${describeMatcher(matcher)} to have been sent. ` +
          `Sent: ${describeSent()}`,
      );
    }
  }

  /** Asserts no request matched. */
  static assertNotSent(matcher: RequestMatcher): void {
    const matched = Http.matches(matcher);

    if (matched.length > 0) {
      throw new Error(
        `Expected no request matching ${describeMatcher(matcher)} to have been sent, ` +
          `but ${matched.length} was. Sent: ${describeSent()}`,
      );
    }
  }

  /**
   * Asserts requests matched `matchers` in order. Other requests may be
   * interleaved; only the relative order of the matched ones is checked.
   */
  static assertSentInOrder(matchers: RequestMatcher[]): void {
    let cursor = 0;

    for (const matcher of matchers) {
      const index = factory
        .recorded()
        .findIndex((pair, at) => at >= cursor && matchesPair(matcher, pair));

      if (index === -1) {
        throw new Error(
          `Expected a request matching ${describeMatcher(matcher)} to have been sent in order ` +
            `at position ${cursor + 1} or later. Sent: ${describeSent()}`,
        );
      }

      cursor = index + 1;
    }
  }

  /** Asserts exactly `count` requests were sent. */
  static assertSentCount(count: number): void {
    const actual = factory.recorded().length;

    if (actual !== count) {
      throw new Error(
        `Expected ${count} request(s) to have been sent, but ${actual} were. Sent: ${describeSent()}`,
      );
    }
  }

  /** Asserts no requests at all were sent. */
  static assertNothingSent(): void {
    const actual = factory.recorded().length;

    if (actual !== 0) {
      throw new Error(
        `Expected no requests to have been sent, but ${actual} were. Sent: ${describeSent()}`,
      );
    }
  }

  /** Asserts every registered response sequence was fully drained. */
  static assertSequencesAreEmpty(): void {
    factory.assertSequencesAreEmpty();
  }

  private static matches(matcher: RequestMatcher): readonly RecordedPair[] {
    return factory.recorded().filter((pair) => matchesPair(matcher, pair));
  }

  /** Swaps the module-level factory. Called by `HttpClientServiceProvider`. */
  static swap(next: HttpClientFactory): void {
    factory = next;
  }

  /** The factory currently backing the static surface. */
  static getFactory(): HttpClientFactory {
    return factory;
  }
}

function matchesPair(matcher: RequestMatcher, pair: RecordedPair): boolean {
  const [request, response] = pair;

  return typeof matcher === "function"
    ? matcher(request, response)
    : urlMatch(matcher, request.url);
}

function describeMatcher(matcher: RequestMatcher): string {
  return typeof matcher === "string" ? `"${matcher}"` : "the given predicate";
}

/** The sent-request list quoted in an assertion failure, so it is actionable. */
function describeSent(): string {
  const sent = factory.recorded().map(([request]) => `${request.method} ${request.url}`);

  return sent.length === 0 ? "(none)" : sent.join(", ");
}

export type { StubResponse, StubHandler, StubEntry };
