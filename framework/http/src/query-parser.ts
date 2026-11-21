/**
 * Bracket-notation parser for query strings and urlencoded form bodies,
 * the `parse_str()`/`qs` behaviour every HTTP client already assumes.
 *
 * Without it, `?ids[]=1&ids[]=2` arrives as the single string-keyed entry
 * `{"ids[]": "1"}` and `user[name]=bob` as `{"user[name]": "bob"}`, which
 * has two consequences beyond ugliness:
 *
 *  - a validation rule of `array()` on a query field can never pass,
 *    because no query field is ever an array; and
 *  - the second `ids[]` value is silently discarded, so a filter over
 *    three ids quietly becomes a filter over one.
 *
 * Both are the kind of bug that looks like an application error for a
 * long time before anyone suspects the framework.
 *
 * The supported syntax, matching PHP/Laravel and `qs`:
 *
 *   ids[]=1&ids[]=2          → { ids: ["1", "2"] }
 *   ids[0]=1&ids[1]=2        → { ids: ["1", "2"] }
 *   user[name]=bob           → { user: { name: "bob" } }
 *   user[address][city]=x    → { user: { address: { city: "x" } } }
 *   a=1&a=2                  → { a: "2" }          (last wins, as PHP)
 */

/**
 * Maximum bracket depth honoured. Deeper keys are kept verbatim as a
 * single literal key rather than expanded.
 *
 * This is a denial-of-service bound, not a style preference: nesting is
 * attacker-controlled (it is just a query string), each level allocates
 * an object, and a single request can otherwise carry thousands of
 * levels for a few hundred bytes. Eight is past anything a real API
 * models and far short of any memory concern.
 */
const MAX_DEPTH = 8;

/**
 * Maximum number of elements a bracket-indexed array may hold. Guards
 * the other cheap amplification: `?a[10000000]=1` is 16 bytes and would
 * otherwise ask for a ten-million-element array.
 *
 * An index past this limit degrades to an object key rather than
 * erroring. The request is still served, it just doesn't get an array.
 */
const MAX_ARRAY_INDEX = 1000;

/** Marker for the `[]` push segment, distinguishable from the literal key `""`. */
const PUSH = Symbol("push");

type Segment = string | typeof PUSH;

/**
 * Keys that reach an object's prototype. Writing through `__proto__` from a
 * query string mutates `Object.prototype` for the whole process, so any key
 * holding one of these, at any depth, is dropped.
 */
function isUnsafeKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

/**
 * Split a bracket-notation key into path segments, or return `undefined`
 * when the key is not bracket notation (or is malformed) and should be
 * used verbatim.
 */
function parseKeyPath(key: string): Segment[] | undefined {
  const open = key.indexOf("[");

  if (open === -1) {
    return undefined;
  }

  // `[a]=1`, no root name. Not something any client produces on
  // purpose; keep it literal rather than inventing a root.
  if (open === 0) {
    return undefined;
  }

  const segments: Segment[] = [key.slice(0, open)];
  let index = open;

  while (index < key.length) {
    if (key[index] !== "[") {
      return undefined;
    } // trailing junk: `a[b]c`

    const close = key.indexOf("]", index);

    if (close === -1) {
      return undefined;
    } // unbalanced: `a[b`

    const inner = key.slice(index + 1, close);
    segments.push(inner === "" ? PUSH : inner);
    index = close + 1;

    if (segments.length > MAX_DEPTH) {
      return undefined;
    }
  }

  return segments;
}

/** A node under construction: a plain object keyed by segment. */
type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Assign `value` at `path` within `root`, creating intermediate objects.
 *
 * Conflicts (a scalar already sitting where a container is needed, e.g.
 * `a=1&a[b]=2`) resolve in favour of the container, matching PHP. The
 * alternative, throwing, would turn a malformed query string into a
 * 500 on a route that never looked at that parameter.
 */
function assign(root: Node, path: Segment[], value: string): void {
  let node = root;

  for (let i = 0; i < path.length - 1; i++) {
    const key = segmentKey(node, path[i]!);
    // Own properties only. An inherited value is never a node to descend
    // into, it belongs to the prototype.
    const existing = Object.hasOwn(node, key) ? node[key] : undefined;

    if (!isNode(existing)) {
      node[key] = {};
    }

    node = node[key] as Node;
  }

  const last = path[path.length - 1]!;
  node[segmentKey(node, last)] = value;
}

/**
 * Resolve a segment to a concrete string key. `[]` becomes the next free
 * integer index in the containing node, which is what makes repeated
 * `ids[]` accumulate rather than overwrite.
 */
function segmentKey(node: Node, segment: Segment): string {
  if (segment !== PUSH) {
    return segment;
  }

  let index = 0;

  while (Object.prototype.hasOwnProperty.call(node, String(index))) {
    index++;
  }

  return String(index);
}

/**
 * Convert every node whose keys are exactly `0..n-1` into a real array,
 * depth-first. This is the step that makes `ids[]=1&ids[]=2` satisfy an
 * `array()` validation rule rather than merely look like one.
 *
 * Deliberately conservative, a node with a gap (`a[0]`, `a[2]`) or a
 * non-numeric sibling stays an object, so no data is dropped to make the
 * shape tidier.
 */
function arrayify(value: unknown): unknown {
  if (!isNode(value)) {
    return value;
  }

  const converted: Node = {};

  for (const [key, child] of Object.entries(value)) {
    converted[key] = arrayify(child);
  }

  const keys = Object.keys(converted);

  if (keys.length === 0) {
    return converted;
  }

  const indices = keys.map((key) => (/^\d+$/.test(key) ? Number(key) : -1));

  if (indices.some((index) => index < 0 || index > MAX_ARRAY_INDEX)) {
    return converted;
  }

  const sorted = [...indices].sort((a, b) => a - b);
  const contiguous = sorted.every((index, position) => index === position);

  if (!contiguous) {
    return converted;
  }

  return sorted.map((index) => converted[String(index)]);
}

/**
 * Parse `[key, value]` entries, as produced by `URLSearchParams` or
 * Hono's `c.req.queries()`, into a nested structure.
 *
 * Values stay strings; this layer decides *shape*, never type. Coercion
 * is the validator's job (`numberRule().integer()`), and doing it here
 * would mean `?zip=01234` silently became `1234`.
 */
export function parseNestedEntries(entries: Iterable<[string, string]>): Record<string, unknown> {
  const root: Node = {};

  for (const [key, value] of entries) {
    const path = parseKeyPath(key);

    if (path === undefined ? isUnsafeKey(key) : path.some((s) => s !== PUSH && isUnsafeKey(s))) {
      continue;
    }

    if (path === undefined) {
      // Plain key. Last occurrence wins, as PHP's `parse_str` does.
      // `?a=1&a=2` is `2`. A client that wants both values writes
      // `a[]=1&a[]=2`, which is unambiguous.
      root[key] = value;
      continue;
    }

    assign(root, path, value);
  }

  return arrayify(root) as Record<string, unknown>;
}

/** Parse a raw query string (with or without a leading `?`). */
export function parseNestedQuery(query: string): Record<string, unknown> {
  const normalized = query.startsWith("?") ? query.slice(1) : query;

  return parseNestedEntries(new URLSearchParams(normalized));
}
