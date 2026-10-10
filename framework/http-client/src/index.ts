/**
 * `@mahiframework/http-client`, a fluent, faketable outbound HTTP client, port of
 * Laravel's `Illuminate\Http\Client` (`Http::withToken()->post()`,
 * `Http::fake()`, `Http::assertSent()`).
 *
 * Built on the platform `fetch`, no `undici`, `axios`, or `node-fetch`
 * dependency, matching the framework's "minimal dependencies" pattern.
 * Anything `fetch` supports that this doesn't wrap (proxies, TLS options)
 * is reachable through `withFetchOptions()`.
 *
 * Independent of `@mahiframework/http`, which owns the *inbound* `Request`/`Response`
 * names, neither package imports the other; both just speak WHATWG
 * `Request`/`Response`.
 *
 * ```ts
 * import { Http } from "@mahiframework/http-client";
 *
 * const response = await Http.withToken(token).post("https://api.example.com/users", { name: "Ada" });
 * console.log(response.json<{ id: number }>().id);
 *
 * // In tests:
 * Http.fake({ "api.example.com/*": { id: 1 } });
 * await createUser();
 * Http.assertSent("api.example.com/users");
 * Http.restore();
 * ```
 */
export { Http } from "./http.js";
export type { RequestMatcher } from "./http.js";

export { HttpClientFactory } from "./http-client-factory.js";
export type { RecordedPair } from "./http-client-factory.js";

export { PendingRequest } from "./pending-request.js";
export type { BodyFormat, SendOptions, SendObserver } from "./pending-request.js";

export { ClientRequest } from "./client-request.js";
export type { ClientRequestBody, ClientRequestInit } from "./client-request.js";

export { makeClientResponse } from "./client-response.js";
export type { ClientResponse, MakeClientResponseOptions } from "./client-response.js";

export { ResponseSequence } from "./response-sequence.js";

export { fetchTransport } from "./transport.js";
export type { Transport } from "./transport.js";

export type { StubResponse, StubHandler, StubEntry, StubResponseSpec } from "./stub.js";
export type { Sink } from "./sink.js";
export type { Attachment, AttachmentContents } from "./multipart.js";

export {
  ConnectionError,
  RequestFailedError,
  StrayRequestError,
  TooManyRedirectsError,
} from "./errors.js";

// Per-hop redirect validation. The piece an app cannot write for itself,
// because `fetch` follows the whole chain inside one call and the
// intermediate hops are not observable.
export { nextHop, redirectTarget, DEFAULT_MAX_REDIRECTS } from "./safe-redirects.js";
export type { SafeRedirectOptions } from "./safe-redirects.js";

export { RequestSending, ResponseReceived, ConnectionFailed } from "./events.js";
export type { HttpClientEvent, EventSink } from "./events.js";

export { HttpClientServiceProvider, HTTP_CLIENT_TOKEN } from "./http-client-service-provider.js";
export type { HttpClientConfig, HttpClientOptions } from "./http-client-config.js";
