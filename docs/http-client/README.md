# HTTP client

`@mahiframework/http-client` makes outbound HTTP requests, the port of Laravel's
`Illuminate\Http\Client` (`Http::withToken()->post()`, `Http::fake()`,
`Http::assertSent()`).

It is independent of `@mahiframework/http`, which handles *inbound* requests.
Neither package imports the other; both just speak WHATWG
`Request`/`Response`.

```ts
import { Http } from "@mahiframework/http-client";

const response = await Http.withToken(token).post("https://api.example.com/users", {
  name: "Ada",
});

if (response.successful()) {
  console.log(response.json<{ id: number }>().id);
}
```

## Contents

- [The basics](#the-basics)
- [Building requests](#building-requests)
- [Responses](#responses)
- [Error handling](#error-handling)
- [Retries](#retries)
- [Middleware](#middleware)
- [Concurrent requests](#concurrent-requests)
- [Streaming and downloads](#streaming-and-downloads)
- [Testing](#testing)
- [Outbound URL safety](#outbound-url-safety)
- [Configuration](#configuration)
- [Differences from Laravel](#differences-from-laravel)

## The basics

Every verb is async and returns a `ClientResponse`:

```ts
await Http.get("https://api.example.com/users");
await Http.get("https://api.example.com/users", { page: 2 });   // query params
await Http.post("https://api.example.com/users", { name: "Ada" });
await Http.put("https://api.example.com/users/1", { name: "Ada L" });
await Http.patch("https://api.example.com/users/1", { name: "Ada L" });
await Http.delete("https://api.example.com/users/1");
await Http.head("https://api.example.com/users");
```

**A non-2xx response resolves, it does not reject.** A 404 or a 500 is an
ordinary return value you inspect:

```ts
const response = await Http.get("https://api.example.com/users/999");

response.status;        // 404
response.successful();  // false
response.notFound();    // true
```

Only a *transport* failure, DNS, connection refused, TLS, timeout,
rejects, as a `ConnectionError`. If a send rejects, the request never got
an answer. Raising on a failed status is opt-in via
[`throw()`](#error-handling).

### Built on `fetch`

The transport is the platform `fetch` (undici-backed on Node 26), not a
third-party client. `undici` *is* `fetch` here, so depending on it would
duplicate the runtime; `axios` would make this a port of axios wearing
Laravel's method names. Anything `fetch` supports that this package
doesn't wrap is reachable through
[`withFetchOptions()`](#escape-hatches).

## Building requests

The builder is **immutable**. Every method returns a new
`PendingRequest`, so a configured client is safe to hold, reuse, and use
concurrently:

```ts
const github = Http.baseUrl("https://api.github.com")
  .withToken(process.env.GITHUB_TOKEN!)
  .acceptJson()
  .timeout(10_000);

const [user, repos] = await Promise.all([github.get("/user"), github.get("/repos")]);
```

### Body formats

```ts
await Http.asJson().post(url, { name: "Ada" });        // the default
await Http.asForm().post(url, { name: "Ada" });        // x-www-form-urlencoded
await Http.asMultipart().post(url, { name: "Ada" });   // multipart/form-data
await Http.withBody("raw text", "text/plain").post(url);
await Http.contentType("application/vnd.api+json").post(url, payload);
```

### Attachments

`attach()` forces multipart and lets `fetch` generate the boundary:

```ts
await Http.attach("avatar", imageBytes, "me.png")
  .attach("resume", "plain text CV", "cv.txt")
  .post("https://api.example.com/profile", { name: "Ada" });
```

### Headers and auth

```ts
Http.withHeaders({ "X-App": "mahi", Accept: "application/json" });
Http.withHeader("X-Request-Id", id);
Http.appendHeader("X-Multi", "a").appendHeader("X-Multi", "b");   // "a, b"
Http.accept("application/xml");
Http.acceptJson();
Http.withUserAgent("mahi/1.0");

Http.withToken(token);                    // Authorization: Bearer <token>
Http.withToken(token, "Token");           // Authorization: Token <token>
Http.withBasicAuth("ada", "s3cret");      // Authorization: Basic <base64>
```

`withHeaders()` **replaces** on collision. Laravel's accumulates into an
array. See [Differences](#differences-from-laravel).

### URLs

```ts
Http.baseUrl("https://api.example.com").get("/users");   // absolute URLs still win

Http.withUrlParameters({ host: "api.github.com", repo: "mahi" })
  .get("https://{host}/repos/{repo}");

Http.withQueryParameters({ page: 1, tag: ["a", "b"] }).get(url);
```

Placeholder values are percent-encoded, so a parameter can't inject path
segments. Query arrays expand to repeated keys (`tag=a&tag=b`); nested
objects expand to bracket notation (`{ filter: { status: "x" } }` →
`filter[status]=x`), the inverse of the inbound query parser; `null`/
`undefined` values are skipped. The same nesting applies to `asForm()` and
`asMultipart()` bodies.

### Escape hatches

`withFetchOptions()` merges raw `RequestInit` over everything the builder
produced, the analogue of dropping Guzzle options straight in. Proxies
and TLS settings live here, via undici's non-standard `dispatcher`:

```ts
import { ProxyAgent } from "undici";   // the *app's* dependency, not this package's

await Http.withFetchOptions({ dispatcher: new ProxyAgent(proxyUrl) }).get(url);
```

`withTransport()` swaps the transport function outright, the seam fakes,
mocks, and record/replay hook into:

```ts
await Http.withTransport(async (request, init) => new Response("stubbed")).get(url);
```

`timeout()` and a caller-supplied `signal` compose rather than override.
When you pass your own `AbortSignal` via `withFetchOptions({ signal })`, a
`timeout()` still applies, the request aborts as soon as *either* fires
(`AbortSignal.any`), so a cancellation signal never silently disables the
timeout:

```ts
await Http.timeout(5_000)
  .withFetchOptions({ signal: controller.signal })   // cancel + timeout both live
  .get(url);
```

## Responses

The body is buffered once and memoised, so accessors are **synchronous and
repeatable**, a platform `Response` body is single-use, and making every
accessor async would poison every call site:

```ts
const response = await Http.get(url);

response.body();               // string
response.json<User>();         // parsed, memoised
response.json("user.name");    // dot-path lookup
response.json("user.age", 0);  // with a fallback
response.collect<Item>("items");
response.bytes();              // Uint8Array

response.status;        // number
response.url;           // effective URL, post-redirect
response.durationMs;
response.header("content-type");
response.headers();
response.cookies();     // parsed from Set-Cookie
```

Status predicates: `successful()`, `ok()`, `created()`, `noContent()`,
`redirect()`, `failed()`, `clientError()`, `serverError()`,
`unauthorized()`, `forbidden()`, `notFound()`, `unprocessable()`,
`tooManyRequests()`.

`failed()` covers 4xx **and** 5xx, but not a 3xx.

## Error handling

`throw()` raises `RequestFailedError` on a failed response, is a no-op on
success, and returns the response either way, so it chains:

```ts
const user = (await Http.get(url)).throw().json<User>();
```

The response body is included in the error message (truncated), because a
bare "status code 422" is useless without the validation errors.

```ts
Http.throw();                                  // on the builder, before sending
Http.throwIf((response) => response.status === 419);
Http.throwUnless((response) => response.ok());

// On the response:
response.throw((r, error) => log(r.status));
response.throwIf(condition);
response.throwUnless(condition);
response.throwIfStatus(404);                   // unconditional — fires on a 2xx too
response.throwUnlessStatus(200);
response.onError((r) => log(r.status));        // never throws
response.toException();                        // the error, or undefined
```

Errors:

| Error | When |
|---|---|
| `ConnectionError` | The transport failed. No response was received. |
| `RequestFailedError` | A failed status, and you opted into throwing. |
| `TooManyRedirectsError` | A `withSafeRedirects()` chain exceeded its hop cap. Carries the chain. |
| `UnsafeUrlError` | A `withSafeRedirects()` hop failed its policy. From `@mahiframework/core`. |
| `StrayRequestError` | A request matched no stub while faking. Never thrown in production. |

`StrayRequestError` extends `Error` directly, not a shared base, so
`catch (e) { if (e instanceof ConnectionError) ... }` in application code
cannot swallow a test-harness failure.

## Retries

```ts
await Http.retry(3).get(url);              // 3 attempts, no delay
await Http.retry(3, 100).get(url);         // 100ms between attempts
await Http.retry(4, [100, 500, 2000]).get(url);
await Http.retry(3, (attempt) => attempt * 100).get(url);
```

**Everything that failed is retryable by default**, any 4xx or 5xx,
including 401 and 422, plus `ConnectionError`. That is Laravel's behaviour.

Retrying a 422 that will never succeed is wasteful, but a status allow-list
baked into the framework would be worse: a 401 *is* retryable when
middleware refreshes an expired token between attempts, and a 409 is
against an optimistic-locking API. A client can't tell those apart from the
status alone, and the failure would look like the framework ignoring your
`retry(3)`. Predictability wins; narrowing is one predicate:

```ts
// "Retry only 5xx and connection failures" — the common intent.
await Http.retry(3, 100, (error, response) =>
  error instanceof ConnectionError || (response?.serverError() ?? false),
).get(url);
```

The predicate gets `(undefined, response)` for a failed status and
`(error, undefined)` for a transport failure.

**`Retry-After` is honoured** on a 429 or 503 carrying it (delta-seconds or
an HTTP-date), overriding the configured backoff, capped at 60s. Laravel
ignores the header, which is the single most common reason a retrying
client gets rate-limit-banned.

On exhaustion the final failed response is **returned**, not thrown,
`throw()` still governs raising:

```ts
const response = await Http.retry(3).get(url);   // resolves with the last 500
await Http.retry(3).throw().get(url);            // raises after 3 attempts
```

Retry wraps the whole pipeline, so middleware re-runs and `RequestSending`
fires once per attempt.

**Bodies must be replayable.** Each attempt re-sends the request body, so a
one-shot `ReadableStream` body can't be retried. It is consumed by the
first attempt and there is nothing left to send. Rather than let the second
attempt fail with an opaque "body is disturbed or locked" error (which would
be mislabelled as a `ConnectionError` and retried again), `retry()` refuses
such a request up front with a clear message. Use a `string` or `Uint8Array`
body, or buffer the stream yourself, when the request needs retries.
String, `Uint8Array`, `FormData`, and JSON bodies are all replayable.

## Middleware

Middleware is `@mahiframework/pipeline`'s `PipeFn`, one mechanism covering
Laravel's `withMiddleware` + `beforeSending` + `afterResponse`. A pipe sees
the request on the way down and the response on the way back:

```ts
await Http.withMiddleware(async (request, next) => {
  const started = Date.now();
  const response = await next(request.withHeader("X-Trace", traceId));
  metrics.record(Date.now() - started, response.status);
  return response;
}).get(url);
```

Shorthands for the one-directional cases:

```ts
Http.withRequestMiddleware((request) => request.withHeader("X-Signed", sign(request)));
Http.withResponseMiddleware((response) => log(response) ?? response);
```

A pipe that returns without calling `next()` short-circuits. The
transport never runs, which is how you'd build a cache layer.

Ordering is global middleware outermost, per-request inside it, transport
innermost.

## Concurrent requests

```ts
const { user, repos } = await Http.pool(
  (http) => ({
    user: () => http.get("https://api.example.com/user"),
    repos: () => http.get("https://api.example.com/repos"),
  }),
  { concurrency: 2 },
);
```

Keys are preserved and a per-entry failure lands as an `Error` **value**,
so one failure never discards the other results. Check with
`instanceof Error` before using an entry.

The callback returns **thunks**, not promises: a promise is already running
by the time you hold one, so an array of them can't be concurrency-limited.
That is why this needs none of Laravel's `LazyPromise` machinery.

`Http.pool()` is a thin wrapper over `@mahiframework/core`'s
[`pooled()`](../helpers/), which is general. Pooling has nothing to do
with HTTP.

## Streaming and downloads

`sink()` writes the body straight to a file or `WritableStream`, so a large
download never lands in memory:

```ts
await Http.sink("/tmp/big-file.zip").get("https://example.com/big-file.zip");
await Http.sink(writableStream).get(url);
```

`stream()` skips buffering entirely and hands you the raw stream. `body()`,
`json()`, and `bytes()` then throw, pointing you at `stream()`:

```ts
const response = await Http.stream().get("https://example.com/huge.ndjson");

for await (const chunk of response.stream()) {
  process(chunk);
}
```

Streaming *request* bodies work too. `duplex: "half"` is set for you
whenever the body is a `ReadableStream`, which is exactly the detail that
otherwise fails at runtime.

## Testing

See [Testing → Faking HTTP requests](../testing/#faking-http-requests) for
the full guide. In short:

```ts
import { Http } from "@mahiframework/http-client";

afterEach(() => Http.restore());

it("notifies the webhook", async () => {
  Http.fake({ "hooks.example.com/*": { ok: true } });

  await notify();

  Http.assertSent("hooks.example.com/deploy");
});
```

An unmatched request raises `StrayRequestError` rather than reaching the
network. `Http.allowStrayRequests()` opts out.

## Outbound URL safety

Nothing is validated by default. A URL built from user input can reach
`169.254.169.254`, `localhost` or an RFC 1918 address, and the client
will fetch it — which is correct for a client whose caller chose the
URL, and a problem the moment any part of one is attacker-influenced.

Two pieces, because they answer different questions.

**`assertSafeUrl()`**, from `@mahiframework/core`, for a single URL.
Pure, no HTTP dependency:

```ts
import { assertSafeUrl, UnsafeUrlError } from "@mahiframework/core";

try {
  await assertSafeUrl(input);                       // public targets only
  await assertSafeUrl(input, { allowPrivate: true }); // plus your LAN
} catch (error) {
  if (error instanceof UnsafeUrlError) {
    return response.unprocessable({ url: error.rule });
  }
}
```

It rejects a scheme outside `["https:", "http:"]`, credentials in the
URL, a host that resolves to nothing, and any resolved address that is
loopback, RFC 1918, link-local, CGNAT or an IPv6 equivalent. **Cloud
metadata addresses are rejected even under `allowPrivate: true`** —
that setting is the normal one for a self-hosted app talking to its own
network, and the metadata address sits inside the range it opens.
`error.rule` names what rejected, so a UI can say which.

**`withSafeRedirects()`**, here, for the chain:

```ts
await Http.withSafeRedirects({ maxRedirects: 3 }).get(url);
```

This is the piece you cannot write yourself. `fetch` follows the whole
redirect chain inside one call and exposes only the final URL, so a
request middleware sees one public URL while a hop to `127.0.0.1`
happens unobserved. Driving the chain manually means reimplementing 303
method rewriting, 307/308 body replay, cross-host credential stripping
and a hop cap — so the package does it:

| | |
|---|---|
| Every hop, including the first | validated before the request goes out |
| 303 | rewritten to `GET`, body dropped |
| 301/302 on a `POST` | rewritten to `GET` |
| 307/308 | method and body preserved |
| Cross-host hop | `Authorization` and `Cookie` dropped |
| Past the cap | `TooManyRedirectsError`, carrying the chain |

> [!WARNING]
> **A hostname check is time-of-check-to-time-of-use racy.**
> `assertSafeUrl()` resolves the host; the transport then resolves it
> again, and a name that answered a public address the first time can
> answer `127.0.0.1` the second — DNS rebinding. Closing that means
> connecting to the address that was validated while carrying the
> original hostname in `Host`, which needs a custom `undici` dispatcher
> with a pinned `lookup`; `undici` is not a dependency of this package,
> and Node's `fetch` silently *discards* a caller-supplied `Host`
> header, so the obvious workaround fails quietly. Treat a pass as
> "not obviously hostile", not as a guarantee.

Validate at **fetch** time, not only when a URL is saved. A save-time
check is a rebinding hole by construction: the host that validated when
an admin pressed save resolves again, later, from a different process.
A save-time pass is for the error message.

## Configuration

Optional. The package works standalone with no container. Register
`HttpClientServiceProvider` to configure defaults and named clients:

```ts
// config/http-client.ts
export default {
  timeout: 10_000,
  headers: { "User-Agent": "mahi/1.0" },
  clients: {
    github: {
      baseUrl: "https://api.github.com",
      headers: { Accept: "application/vnd.github+json" },
    },
  },
} satisfies HttpClientConfig;
```

```ts
await Http.client("github").get("/user");
```

The provider also wires event dispatch when `@mahiframework/events` is registered:
`RequestSending`, `ResponseReceived`, and `ConnectionFailed`. Without a
dispatcher, events are silently skipped.

## Differences from Laravel

**An unmatched fake raises instead of hitting the network.** Laravel's
`Http::fake()` falls through to the real handler for an unmatched request,
so a typo'd pattern silently makes a live call from your test suite.
`preventStrayRequests()` is opt-in there. Here the safe behaviour is the
default and `allowStrayRequests()` opts out.

**`Retry-After` is honoured.** On a 429/503, the server's delay overrides
your backoff (capped at 60s). Laravel ignores the header.

**`withHeaders()` replaces rather than accumulates.** Laravel uses
`array_merge_recursive`, so `withHeaders({X:'1'}).withHeaders({X:'2'})`
yields `X: ['1','2']`, the reason its `replaceHeaders()` exists at all.
Ours replaces; `appendHeader()` covers the genuine multi-value case.
`replaceHeaders()` is not ported, having no reason to exist.

**Everything is async.** Laravel's `LazyPromise`, `FluentPromise`,
`async()` toggle, and separate async retry loop all exist to bolt
concurrency onto a synchronous default. Starting async means `pool()` is
`pooled()` over thunks and there is exactly one retry implementation.

**`PendingRequest` is immutable.** Laravel's `send()` mutates the instance,
nulling `pendingBody`, assigning `request`/`cookies`/`transferStats`,
which makes a configured client unsafe to hold or use concurrently.
Copy-on-write fixes that, and holding a `baseUrl()`-configured client is
the entire point.

**`throwIf` takes a real predicate.** Laravel's has the wart that a
callable condition is itself truthy, so `throwIf($closure)` always arms.

### What `fetch` costs

| Guzzle feature | Status here |
|---|---|
| `connect_timeout` separate from `timeout` | **Not available.** One `AbortSignal.timeout()` covers the whole exchange, so `connectTimeout()` is not ported. |
| `on_stats` / `handlerStats()` | **Not available.** You get `durationMs` and the effective `url`. For more, use a response middleware. |
| Digest / NTLM auth | **Not available.** They need a challenge-response round trip; implement one as middleware if you need it. |
| Proxies, TLS options | Via `withFetchOptions({ dispatcher })`, with `undici` as your app's dependency. |
| Cookie jar | **Not automatic.** `withCookies()` sets a header, `response.cookies()` reads them, but nothing persists across requests. |
| `maxRedirects` | **Not available.** `fetch` is follow-or-manual; use `withoutRedirecting()`. |

Also not ported: `dd()` (it calls `exit(1)`, which kills a Node test
runner), `Batch` (promise combinators express it directly), and macros
(the framework has no `Macroable`; facades forward a hand-written method
list).

## Related

- [Testing](../testing/#faking-http-requests): `Http.fake()` and the assertions
- [Helpers](../helpers/): `pooled()` and `retry()`
- [Routing](../routing/) and [Requests](../requests/): the *inbound* side
