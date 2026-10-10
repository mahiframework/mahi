import type { ClientRequest } from "./client-request.js";
import type { ClientResponse } from "./client-response.js";

/**
 * A transport-level failure, DNS, connection refused, TLS, timeout, or an
 * aborted `AbortSignal`. Port of Laravel's
 * `Illuminate\Http\Client\ConnectionException`.
 *
 * This is the **only** thing a send rejects with under normal operation: a
 * non-2xx status resolves with a `ClientResponse` and raises only if you
 * opt in via `throw()`. If it rejects, the request never got an answer.
 */
export class ConnectionError extends Error {
  constructor(
    message: string,
    readonly request: ClientRequest,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ConnectionError";
  }
}

/**
 * Thrown by `response.throw()` / `PendingRequest.throw()` on a failed
 * (4xx/5xx) response, port of `Illuminate\Http\Client\RequestException`.
 * Never thrown unless the caller opted in.
 *
 * The response body is included in the message (truncated to
 * `RequestFailedError.truncateAt` characters) because a bare
 * "HTTP request returned status code 422" is useless without the
 * validation errors the server sent with it.
 */
export class RequestFailedError extends Error {
  /**
   * Characters of response body to include in the message before
   * truncating. Laravel exposes this as `Http::truncateExceptionsAt()`; a
   * static knob is the same thing without a fluent method that has to be
   * threaded through every `PendingRequest` copy. Set to `0` to omit the
   * body entirely.
   */
  static truncateAt = 120;

  constructor(readonly response: ClientResponse) {
    super(RequestFailedError.buildMessage(response));
    this.name = "RequestFailedError";
  }

  private static buildMessage(response: ClientResponse): string {
    const summary = `HTTP request returned status code ${response.status}`;

    if (RequestFailedError.truncateAt <= 0) {
      return `${summary}.`;
    }

    // `body()` throws on a streamed response. There is nothing buffered
    // to quote, and a failure to build an error message must not replace
    // the error being reported.
    let body: string;
    try {
      body = response.body().trim();
    } catch {
      return `${summary}.`;
    }

    if (body === "") {
      return `${summary}.`;
    }

    const truncated =
      body.length > RequestFailedError.truncateAt
        ? `${body.slice(0, RequestFailedError.truncateAt)}...`
        : body;

    return `${summary}:\n${truncated}`;
  }
}

/**
 * A `withSafeRedirects()` chain exceeded its hop cap.
 *
 * Distinct from a `ConnectionError`: every hop answered, and the chain
 * is well-formed in the sense that each `Location` validated — there
 * were simply too many. Carries the whole chain, because "where did it
 * go" is the question, and a redirect loop is only legible as a list.
 *
 * Not reachable without `withSafeRedirects()`: `fetch` enforces its own
 * cap internally and reports exhaustion as a generic failure.
 */
export class TooManyRedirectsError extends Error {
  constructor(
    readonly request: ClientRequest,
    /** Every URL requested, in order, plus the one that was refused. */
    readonly chain: readonly string[],
    readonly maxRedirects: number,
  ) {
    super(
      `Gave up after ${maxRedirects} redirect(s): ${chain.join(" -> ")}. Raise maxRedirects if ` +
        `the chain is legitimate.`,
    );
    this.name = "TooManyRedirectsError";
  }
}

/**
 * Thrown when a request matches no registered stub while `Http.fake()` is
 * active. The request is refused rather than falling through to the real
 * network.
 *
 * Laravel makes this opt-in (`preventStrayRequests()`); here it is the
 * default, because the alternative failure mode is a typo'd pattern
 * silently making a live call from your test suite. `Http.allowStrayRequests()`
 * opts back out.
 *
 * Extends `Error` directly rather than sharing a base with `ConnectionError`
 * / `RequestFailedError`, deliberately, and matching Laravel's choice to
 * extend `RuntimeException` rather than `HttpClientException`. Application
 * code that catches its own client errors must **not** swallow a
 * test-harness failure.
 */
export class StrayRequestError extends Error {
  constructor(readonly request: ClientRequest) {
    super(
      `Attempted request to [${request.method} ${request.url}] without a matching fake. ` +
        `Either add a stub for it via Http.fake({ "<pattern>": ... }), or call ` +
        `Http.allowStrayRequests() to let unmatched requests reach the network.`,
    );
    this.name = "StrayRequestError";
  }
}
