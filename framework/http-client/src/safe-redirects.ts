import type { UrlPolicy } from "@mahiframework/core";
import { ClientRequest } from "./client-request.js";

/** What `withSafeRedirects()` records. */
export interface SafeRedirectOptions extends UrlPolicy {
  /**
   * How many redirects to follow before giving up. Defaults to 5.
   *
   * A cap rather than a cycle detector: a chain can be long without
   * repeating, and "how many hops is this worth" is the question a
   * caller can actually answer.
   */
  maxRedirects?: number;
}

export const DEFAULT_MAX_REDIRECTS = 5;

/**
 * The statuses that mean "ask again somewhere else".
 *
 * 304 is 3xx and is NOT one: it means the cached copy stands. 305 and
 * 306 are withdrawn and no client has honoured them in two decades.
 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The absolute URL a redirect points at, or undefined when the response
 * is not a redirect this follows.
 *
 * A 3xx with no `Location` is returned to the caller rather than treated
 * as an error — there is nowhere to go, and the status is the answer.
 */
export function redirectTarget(response: Response, from: string): string | undefined {
  if (!REDIRECT_STATUSES.has(response.status)) {
    return undefined;
  }

  const location = response.headers.get("location");

  if (location === null || location.trim() === "") {
    return undefined;
  }

  try {
    return new URL(location, from).toString();
  } catch {
    // A `Location` that is not a URL is not somewhere to go. The 3xx
    // itself is returned, which is more useful than inventing a failure.
    return undefined;
  }
}

/**
 * The request for the next hop.
 *
 * THREE RULES, all of which an app driving `redirect: "manual"` by hand
 * has to get right and usually does not:
 *
 * **303 rewrites the method to GET and drops the body.** That is the
 * entire purpose of 303 — "your POST was accepted, now GET the result" —
 * and replaying the body would re-submit it.
 *
 * **301 and 302 rewrite a POST to GET, and nothing else.** Historical,
 * universal, and what every browser does; a 301 on a PUT keeps the PUT.
 *
 * **307 and 308 preserve the method AND replay the body.** They exist
 * precisely to say "do the same thing again over there", which is why a
 * streaming body cannot survive them — see `PendingRequest`.
 *
 * And one that is about safety rather than conformance:
 *
 * **`Authorization` and `Cookie` are dropped when the host changes.**
 * A redirect is chosen by the server being redirected away from, so
 * carrying credentials across the hop hands them to whoever that server
 * names. Guzzle does the same. A caller that genuinely needs them on the
 * far side sets them for that request.
 */
export function nextHop(request: ClientRequest, status: number, target: string): ClientRequest {
  const sameHost = new URL(target).host === new URL(request.url).host;
  const rewriteToGet =
    status === 303 || (request.method === "POST" && status !== 307 && status !== 308);

  let next = request.withUrl(target);

  if (rewriteToGet) {
    next = next.withMethod("GET").withBody(undefined);
    // The body is gone, so its description must go too — a `GET` still
    // advertising `Content-Type: application/json` is a lie that some
    // servers answer with a 400.
    next = next.withoutHeader("content-type").withoutHeader("content-length");
  }

  if (!sameHost) {
    next = next.withoutHeader("authorization").withoutHeader("cookie");
  }

  return next;
}
