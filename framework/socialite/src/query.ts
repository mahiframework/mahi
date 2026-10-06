/**
 * Query-string encoding for OAuth authorization URLs.
 *
 * Two encodings, because providers disagree and the difference is
 * observable. Laravel Socialite carries this as `$encodingType`
 * (`PHP_QUERY_RFC1738` by default, `PHP_QUERY_RFC3986` on some
 * providers), and a driver that sends the wrong one gets a signature
 * mismatch or a rejected `redirect_uri` from a strict provider.
 *
 * `URLSearchParams` is not sufficient on its own: it encodes a space as
 * `+` (RFC 1738's rule) but leaves `~` literal (RFC 3986's rule), so it
 * matches neither spec exactly and cannot be configured.
 */
export type QueryEncoding = "rfc1738" | "rfc3986";

/**
 * Percent-encode per RFC 3986 §2.3: unreserved characters are
 * `A-Z a-z 0-9 - _ . ~` and everything else is escaped.
 *
 * `encodeURIComponent` is RFC 3986 apart from leaving `!'()*` alone, so
 * those four are escaped by hand.
 */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Percent-encode per RFC 1738: as RFC 3986, except a space becomes `+`
 * and `~` is escaped to `%7E`.
 */
function encodeRfc1738(value: string): string {
  return encodeRfc3986(value).replace(/%20/g, "+").replace(/~/g, "%7E");
}

/**
 * Build a query string from `params`, skipping entries whose value is
 * `undefined` (so an optional field can be spread in unconditionally).
 *
 * Insertion order is preserved rather than sorted: an authorization URL
 * is not signed, and keeping `client_id` first makes a logged URL
 * readable.
 */
export function buildQuery(
  params: Record<string, string | undefined>,
  encoding: QueryEncoding = "rfc1738",
): string {
  const encode = encoding === "rfc3986" ? encodeRfc3986 : encodeRfc1738;
  const pairs: string[] = [];

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }

    pairs.push(`${encode(key)}=${encode(value)}`);
  }

  return pairs.join("&");
}
