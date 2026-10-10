import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Which rule rejected a URL.
 *
 * Enumerated rather than collapsed into a message, because the
 * difference matters to a caller: `scheme` and `credentials` are
 * typos an admin can fix, `private` is a deployment decision, and
 * `metadata` is somebody probing. A UI can explain each one; a generic
 * "invalid URL" explains none of them.
 */
export type UnsafeUrlRule =
  /** The string is not a URL at all. */
  | "parse"
  /** The scheme is not in the allow-list. */
  | "scheme"
  /** The URL carries a username or password. */
  | "credentials"
  /** The URL has no host — `http:///path`, or an opaque scheme. */
  | "host"
  /** The host could not be resolved to any address. */
  | "dns"
  /** A resolved address is a cloud metadata endpoint. Never permitted. */
  | "metadata"
  /** A resolved address is private, loopback, link-local, CGNAT or otherwise non-public. */
  | "private";

/** A URL failed `assertSafeUrl()`. `rule` names what rejected it. */
export class UnsafeUrlError extends Error {
  constructor(
    readonly url: string,
    readonly rule: UnsafeUrlRule,
    message: string,
    /** The resolved address that triggered a `metadata` or `private` rejection. */
    readonly address?: string,
  ) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

/** What `assertSafeUrl()` will accept. Every field defaults closed. */
export interface UrlPolicy {
  /**
   * Schemes to allow. Defaults to `["https:", "http:"]`.
   *
   * An allow-list, never a deny-list: `file:`, `data:`, `blob:`,
   * `gopher:` and `ftp:` are the ones people remember, and the next
   * scheme a runtime adds is the one a deny-list misses.
   *
   * Values are compared with a trailing colon, as `URL.protocol`
   * reports them, and a bare `"https"` is accepted and normalised.
   */
  schemes?: readonly string[];

  /**
   * Allow RFC1918, loopback, link-local, CGNAT and the IPv6
   * equivalents. Defaults to false.
   *
   * `true` is the normal setting for a self-hosted application talking
   * to its own network — a NAS on `192.168.1.10`, a sidecar on
   * `127.0.0.1`. It does NOT permit the cloud metadata addresses; see
   * the class of trouble that exception exists for in
   * `assertSafeUrl()`.
   */
  allowPrivate?: boolean;

  /**
   * Reject a URL carrying credentials (`https://user:pass@host/`).
   * Defaults to true.
   *
   * On by default because the userinfo form is the oldest URL
   * confusable there is: `https://trusted.test@evil.test/` reads as
   * `trusted.test` to a person and resolves to `evil.test`.
   */
  rejectCredentials?: boolean;

  /**
   * Hosts to accept without resolving, exact match, case-insensitive.
   *
   * The escape hatch for a target that genuinely lives on a private
   * address and should not require opening the whole private space:
   * `{ allowHosts: ["nas.internal"] }` rather than
   * `{ allowPrivate: true }`. The scheme and credential rules still
   * apply — only address checking is skipped.
   */
  allowHosts?: readonly string[];
}

const DEFAULT_SCHEMES = ["https:", "http:"] as const;

/**
 * Cloud instance metadata, rejected unconditionally.
 *
 * `169.254.169.254` is AWS, GCP, Azure, DigitalOcean, Hetzner and
 * OpenStack; `fd00:ec2::254` is the AWS IPv6 form. Nothing legitimate is
 * ever reachable at either, and the response is a credential — on EC2 an
 * IAM role's temporary keys, on GCP an OAuth token for the service
 * account.
 *
 * Unconditional because `allowPrivate: true` is the *normal* setting for
 * a self-hosted app, and `169.254.169.254` is inside the link-local
 * range that setting opens. An exception that `allowPrivate` could lift
 * would be lifted by almost every app that needs the function at all.
 */
const METADATA_ADDRESSES = new Set(["169.254.169.254", "fd00:ec2::254"]);

/**
 * Validate a URL as an outbound target, resolving its host.
 *
 * ```ts
 * const url = await assertSafeUrl(input);           // public targets only
 * await assertSafeUrl(input, { allowPrivate: true }); // plus the LAN
 * ```
 *
 * Rejects, by default: a scheme outside the allow-list; credentials in
 * the URL; a host that resolves to nothing; and any resolved address
 * that is loopback, RFC1918, link-local, CGNAT (`100.64/10`), IPv6
 * ULA/`::1`/`fe80::`, multicast or otherwise not globally routable.
 * Cloud metadata addresses are rejected even under
 * `allowPrivate: true`.
 *
 * EVERY resolved address must pass, not merely the first. A host with
 * one public and one loopback `A` record is rejected: which one a later
 * connection picks is not this function's to decide, and "the first
 * record was fine" is not a property anything can rely on.
 *
 * 🚨 THIS CHECK IS TIME-OF-CHECK-TO-TIME-OF-USE RACY, AND CANNOT BE
 * OTHERWISE FROM HERE. It resolves the hostname; whatever performs the
 * request then resolves it AGAIN, and a name that answered
 * `93.184.216.34` here can answer `127.0.0.1` there — DNS rebinding,
 * against which a by-name check is decorative. Closing it means
 * connecting to the address that was validated and carrying the
 * original hostname in `Host`, which needs a custom dispatcher with a
 * pinned `lookup`; Node's `fetch` silently DISCARDS a caller-supplied
 * `Host` header, so the obvious workaround fails quietly. Treat a pass
 * here as "this target is not obviously hostile", which is worth having
 * for the error message and for the honest mistakes, and not as a
 * guarantee that the bytes went where you checked.
 *
 * Validate at FETCH time, not only when a URL is saved. A save-time
 * check is a rebinding hole by construction: the host that validated
 * when an admin pressed save resolves again, later, from a different
 * process.
 *
 * @returns the parsed `URL`, so a caller can use the normalised form.
 * @throws {UnsafeUrlError} naming the rule that rejected it.
 */
export async function assertSafeUrl(url: string, policy: UrlPolicy = {}): Promise<URL> {
  const parsed = parseUrl(url, policy);

  if (isAllowedHost(parsed, policy)) {
    return parsed;
  }

  for (const address of await resolveAddresses(parsed)) {
    assertAddressAllowed(url, address, policy);
  }

  return parsed;
}

/**
 * The addresses a URL's host resolves to, each validated.
 *
 * For a caller that intends to PIN what it validated — connect to the
 * address rather than re-resolve the name — which is the only way to
 * close the race `assertSafeUrl()` documents. An IP-literal host
 * returns itself.
 *
 * Returns them in resolution order, which is the order the resolver
 * offered and therefore the order a connection would try.
 *
 * @throws {UnsafeUrlError} on the first address that fails, as `assertSafeUrl()` does.
 */
export async function resolveSafeAddresses(url: string, policy: UrlPolicy = {}): Promise<string[]> {
  const parsed = parseUrl(url, policy);
  const addresses = await resolveAddresses(parsed);

  if (!isAllowedHost(parsed, policy)) {
    for (const address of addresses) {
      assertAddressAllowed(url, address, policy);
    }
  }

  return addresses;
}

/**
 * Whether an address is one a `UrlPolicy` would accept.
 *
 * Exported for a caller holding an address rather than a URL — a
 * resolver callback, a socket's `remoteAddress`. Pure and synchronous:
 * no DNS, no policy fields beyond `allowPrivate`.
 */
export function isAllowedAddress(address: string, policy: UrlPolicy = {}): boolean {
  if (isMetadataAddress(address)) {
    return false;
  }

  return policy.allowPrivate === true || !isPrivateAddress(address);
}

/**
 * Whether an address is a cloud instance metadata endpoint.
 *
 * Checked against the IPv4-mapped form too, so
 * `::ffff:169.254.169.254` does not slip past a literal comparison.
 */
export function isMetadataAddress(address: string): boolean {
  const normalised = unwrapMappedIpv4(address) ?? address.toLowerCase();

  if (METADATA_ADDRESSES.has(normalised)) {
    return true;
  }

  // `fd00:ec2::254` has several textual spellings; compare bytes.
  const bytes = parseIpv6(normalised);

  if (bytes === null) {
    return false;
  }

  return METADATA_IPV6_BYTES.some((known) => bytesEqual(known, bytes));
}

/**
 * Whether an address is outside the globally-routable space.
 *
 * True for loopback, RFC1918, link-local, CGNAT, the IETF-reserved
 * blocks, multicast and broadcast, plus the IPv6 equivalents. An
 * IPv4-mapped or NAT64-embedded IPv6 address is unwrapped and judged as
 * the IPv4 address it carries — the alternative is a bypass consisting
 * of writing the same address differently.
 */
export function isPrivateAddress(address: string): boolean {
  const mapped = unwrapMappedIpv4(address);

  if (mapped !== null) {
    return isPrivateAddress(mapped);
  }

  const v4 = parseIpv4(address);

  if (v4 !== null) {
    return isPrivateIpv4(v4);
  }

  const v6 = parseIpv6(address);

  if (v6 === null) {
    // Not an address at all. Refusing to call an unparseable string
    // "public" is the only safe answer available here.
    return true;
  }

  return isPrivateIpv6(v6);
}

// ------------------------------------------------------------------ parsing

function parseUrl(url: string, policy: UrlPolicy): URL {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeUrlError(url, "parse", `"${url}" is not a valid URL.`);
  }

  const schemes = (policy.schemes ?? DEFAULT_SCHEMES).map(normaliseScheme);

  if (!schemes.includes(parsed.protocol)) {
    throw new UnsafeUrlError(
      url,
      "scheme",
      `The "${parsed.protocol}" scheme is not allowed. Allowed: ${schemes.join(", ")}.`,
    );
  }

  if (policy.rejectCredentials !== false && (parsed.username !== "" || parsed.password !== "")) {
    throw new UnsafeUrlError(
      url,
      "credentials",
      `This URL carries credentials in its userinfo, which is not allowed. ` +
        `Send them in a header instead.`,
    );
  }

  if (parsed.hostname === "") {
    throw new UnsafeUrlError(url, "host", "This URL has no host.");
  }

  return parsed;
}

/** `"https"` and `"https:"` both mean the same thing to a caller. */
function normaliseScheme(scheme: string): string {
  return scheme.endsWith(":") ? scheme.toLowerCase() : `${scheme.toLowerCase()}:`;
}

function isAllowedHost(url: URL, policy: UrlPolicy): boolean {
  const host = hostnameOf(url).toLowerCase();

  return (policy.allowHosts ?? []).some((allowed) => allowed.toLowerCase() === host);
}

/**
 * `URL.hostname` without the brackets an IPv6 literal carries.
 *
 * `new URL("http://[::1]/").hostname` is `"[::1]"`, which neither
 * `isIP()` nor a resolver accepts.
 */
function hostnameOf(url: URL): string {
  const host = url.hostname;

  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** Every address a URL's host resolves to. An IP literal resolves to itself. */
async function resolveAddresses(url: URL): Promise<string[]> {
  const host = hostnameOf(url);

  if (isIP(host) !== 0) {
    return [host];
  }

  let resolved;

  try {
    // `verbatim` so the resolver's own order survives rather than being
    // re-sorted to prefer IPv4 — the order is what a connection tries,
    // and the check should see what the connection will.
    resolved = await lookup(host, { all: true, verbatim: true });
  } catch (error) {
    throw new UnsafeUrlError(
      url.href,
      "dns",
      `"${host}" could not be resolved (${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  if (resolved.length === 0) {
    throw new UnsafeUrlError(url.href, "dns", `"${host}" resolved to no addresses.`);
  }

  return resolved.map((entry) => entry.address);
}

function assertAddressAllowed(url: string, address: string, policy: UrlPolicy): void {
  if (isMetadataAddress(address)) {
    throw new UnsafeUrlError(
      url,
      "metadata",
      `This URL resolves to ${address}, a cloud instance metadata endpoint. That is never ` +
        `permitted, including under allowPrivate.`,
      address,
    );
  }

  if (policy.allowPrivate !== true && isPrivateAddress(address)) {
    throw new UnsafeUrlError(
      url,
      "private",
      `This URL resolves to ${address}, which is not a public address. Pass ` +
        `{ allowPrivate: true } if reaching it is intended.`,
      address,
    );
  }
}

// -------------------------------------------------------------- IP handling

/** The four octets, or null when `address` is not a dotted-quad IPv4. */
function parseIpv4(address: string): number[] | null {
  if (isIP(address) !== 4) {
    return null;
  }

  const octets = address.split(".").map(Number);

  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet)) ? octets : null;
}

/** The sixteen bytes, or null when `address` is not an IPv6 address. */
function parseIpv6(address: string): number[] | null {
  if (isIP(address) !== 6) {
    return null;
  }

  // An IPv4-in-IPv6 tail (`::ffff:127.0.0.1`) is legal in the textual
  // form, so split it off and append its octets as the last four bytes.
  const lastColon = address.lastIndexOf(":");
  const tail = address.slice(lastColon + 1);
  const trailingV4 = tail.includes(".") ? parseIpv4(tail) : null;
  const hextets = (trailingV4 === null ? address : address.slice(0, lastColon + 1)).split("::");

  if (hextets.length > 2) {
    return null;
  }

  const head = splitHextets(hextets[0] ?? "");
  const rest = splitHextets(hextets[1] ?? "");
  const groups = trailingV4 === null ? 8 : 6;

  if (hextets.length === 1 && head.length !== groups) {
    return null;
  }

  const gap = groups - head.length - rest.length;

  if (gap < 0) {
    return null;
  }

  const words = [...head, ...Array.from({ length: gap }, () => 0), ...rest];
  const bytes: number[] = [];

  for (const word of words) {
    bytes.push((word >> 8) & 0xff, word & 0xff);
  }

  if (trailingV4 !== null) {
    bytes.push(...trailingV4);
  }

  return bytes.length === 16 ? bytes : null;
}

function splitHextets(part: string): number[] {
  if (part === "") {
    return [];
  }

  return part
    .split(":")
    .filter((piece) => piece !== "")
    .map((piece) => Number.parseInt(piece, 16));
}

/**
 * The IPv4 address an IPv6 address carries, or null.
 *
 * Covers `::ffff:0:0/96` (IPv4-mapped, what a dual-stack socket reports
 * for an IPv4 peer) and `64:ff9b::/96` (the well-known NAT64 prefix).
 * Both are routes to an IPv4 address and must be judged as one.
 */
function unwrapMappedIpv4(address: string): string | null {
  const bytes = parseIpv6(address);

  if (bytes === null) {
    return null;
  }

  const mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const nat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0);

  if (!mapped && !nat64) {
    return null;
  }

  return bytes.slice(12).join(".");
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a = 0, b = 0] = octets;

  return (
    // "this host on this network", and the `0.0.0.0` that means "every
    // interface" to a listener and "localhost" to several resolvers.
    a === 0 ||
    a === 10 ||
    a === 127 ||
    // CGNAT, 100.64.0.0/10. Reachable inside a carrier network and
    // inside several container runtimes.
    (a === 100 && b >= 64 && b <= 127) ||
    // Link-local, which is where the metadata endpoints live.
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    // IETF protocol assignments, 192.0.0.0/24.
    (a === 192 && b === 0 && octets[2] === 0) ||
    (a === 192 && b === 168) ||
    // Benchmarking, 198.18.0.0/15.
    (a === 198 && (b === 18 || b === 19)) ||
    // Multicast and the reserved top of the space, plus broadcast.
    a >= 224
  );
}

function isPrivateIpv6(bytes: number[]): boolean {
  const [first = 0, second = 0] = bytes;

  // `::` and `::1`.
  if (bytes.slice(0, 15).every((byte) => byte === 0) && (bytes[15] === 0 || bytes[15] === 1)) {
    return true;
  }

  return (
    // Unique local, fc00::/7.
    (first & 0xfe) === 0xfc ||
    // Link-local, fe80::/10.
    (first === 0xfe && (second & 0xc0) === 0x80) ||
    // Multicast, ff00::/8.
    first === 0xff
  );
}

const METADATA_IPV6_BYTES = [...METADATA_ADDRESSES]
  .map((address) => parseIpv6(address))
  .filter((bytes): bytes is number[] => bytes !== null);

function bytesEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
