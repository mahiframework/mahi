import { Collection } from "@mahiframework/core";
import type { EloquentBuilder, Hydrated } from "../eloquent-builder.js";
import type { RelationDefinitions } from "../relations.js";

export interface CursorPaginationResult<T> {
  data: Collection<T>;
  nextCursor: string | null;
  prevCursor: string | null;
}

export interface CursorPaginateOptions<T, K extends keyof T & string> {
  /** The sort/cursor column, must be unique and orderable (e.g. `"id"` or a `created_at` timestamp with no ties). */
  column: K;
  direction?: "asc" | "desc";
  perPage: number;
  /** An opaque cursor from a previous result's `nextCursor`/`prevCursor`, or `null`/omitted for the first page. */
  cursor?: string | null;
}

/**
 * Which way a cursor walks from its encoded boundary value: `"after"`
 * cursors (from `nextCursor`) fetch rows after the boundary in the
 * paginator's canonical `direction`; `"before"` cursors (from
 * `prevCursor`) fetch rows before it. Encoding this in the cursor itself
 * (rather than trying to infer it from context) is what makes walking
 * backward correct. See the module docstring below.
 */
interface CursorPayload {
  value: unknown;
  op: "after" | "before";
}

/**
 * Cursor pagination, an opaque cursor (encoding the last-seen sort key,
 * not a page number), returns `nextCursor`/`prevCursor` instead of page
 * numbers. Correct and fast at any depth, immune to length-aware
 * pagination's "shifting results under concurrent writes" problem, but
 * can't jump to "page 7", only "next"/"previous". Matches Laravel's
 * `CursorPaginator`.
 *
 * The cursor column **must** be unique and monotonically orderable, a
 * non-unique cursor column can skip or repeat rows when values tie.
 * Compound cursors (tie-breaking on a second column) are intentionally
 * not supported in this first pass, use a unique column (typically the
 * primary key, or a `created_at` you've made unique) instead.
 *
 * ## `prevCursor` design
 *
 * Walking "backward" requires a reversed query (`orderBy` flipped,
 * comparison operator flipped, then the fetched rows re-reversed before
 * returning), naively echoing the incoming cursor back as `prevCursor`
 * doesn't work. This implementation encodes **which direction a given
 * cursor walks** directly in the cursor payload (`op: "after" | "before"`)
 * rather than trying to infer it from call-site context:
 * - `nextCursor` is always an `"after"` cursor built from the current
 *   page's last row.
 * - `prevCursor` is always a `"before"` cursor built from the current
 *   page's first row.
 * - Consuming a `"before"` cursor runs the query in the reverse
 *   direction/operator, fetches up to `perPage + 1` rows to detect "is
 *   there really a page before this one," then reverses the result back
 *   into the paginator's canonical `direction` before returning `data`.
 */
export async function cursorPaginate<
  T extends Record<string, any>,
  K extends keyof T & string,
  TRel extends RelationDefinitions = Record<never, never>,
  TCasts = Record<never, never>,
  // Constrained by `Pick<T, K>` rather than left free: the cursor is built
  // from `row[options.column]`, so whatever the builder terminates in has to
  // carry that column. A model instance does. It is the row plus methods.
  TInstance extends Pick<T, K> = Hydrated<T, TRel, TCasts> & Pick<T, K>,
>(
  builder: EloquentBuilder<T, TRel, TCasts, TInstance>,
  options: CursorPaginateOptions<T, K>,
): Promise<CursorPaginationResult<TInstance>> {
  const canonicalDirection = options.direction ?? "asc";
  const decoded = options.cursor ? decodeCursor(options.cursor) : undefined;
  const walkingBackward = decoded?.op === "before";
  const perPage = normalizePerPage(options.perPage);

  const queryDirection = walkingBackward
    ? canonicalDirection === "asc"
      ? "desc"
      : "asc"
    : canonicalDirection;
  const operator = queryDirection === "asc" ? ">" : "<";

  builder.orderBy(options.column, queryDirection).limit(perPage + 1);

  if (decoded) {
    builder.where(options.column, operator, decoded.value as T[K]);
  }

  const fetched = (await builder.get()).toArray();
  const hasExtra = fetched.length > perPage;
  let data = hasExtra ? fetched.slice(0, perPage) : fetched;

  if (walkingBackward) {
    data = data.reverse();
  } // restore canonical order

  // Walking backward implies a subsequent page exists by construction
  // (we walked backward FROM it); walking forward, "is there a next
  // page" is exactly what the +1-row overfetch (`hasExtra`) detects.
  const hasNext = walkingBackward ? true : hasExtra;
  // Walking forward from an explicit cursor implies a preceding page
  // exists by construction; walking backward, `hasExtra` detects it.
  const hasPrev = walkingBackward ? hasExtra : decoded !== undefined;

  const nextCursor =
    hasNext && data.length > 0
      ? encodeCursor({ value: data[data.length - 1]![options.column], op: "after" })
      : null;
  const prevCursor =
    hasPrev && data.length > 0
      ? encodeCursor({ value: data[0]![options.column], op: "before" })
      : null;

  return { data: Collection.make(data), nextCursor, prevCursor };
}

/**
 * A cursor value that is a `bigint` is written as `{ "$bigint": "42" }`.
 *
 * The cursor column is very often the primary key, which is 64-bit,
 * and `JSON.stringify` throws on a `bigint` outright — so without this
 * every paginated endpoint keyed on `id` returns a 500. A plain decimal
 * string would round-trip as a string and then be compared against a
 * `bigInteger` column, so the tag records what to restore it to.
 */
interface TaggedBigint {
  $bigint: string;
}

function isTaggedBigint(value: unknown): value is TaggedBigint {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as TaggedBigint).$bigint === "string"
  );
}

function encodeCursor(payload: CursorPayload): string {
  const value =
    typeof payload.value === "bigint"
      ? ({ $bigint: payload.value.toString() } satisfies TaggedBigint)
      : payload.value;

  return Buffer.from(JSON.stringify({ ...payload, value })).toString("base64url");
}

/**
 * Decode an opaque cursor, or `undefined` if it isn't one we produced.
 *
 * Cursors arrive straight off a query string, so this is untrusted input
 * and must never throw: a bare `JSON.parse()` here meant `?cursor=garbage`
 * raised a `SyntaxError` that fell through the HTTP error handler as a
 * **500** on every paginated endpoint, a client typo crashing the
 * request. A cursor that doesn't decode to the exact `{ value, op }`
 * shape `encodeCursor()` produces is therefore treated as "no cursor" and
 * the caller simply gets the first page.
 *
 * The shape check also matters beyond parse failures: a payload decoding
 * to a non-object (`[]`, `"str"`), or missing `value`, would otherwise
 * sail through as a real cursor and produce a silently EMPTY page, while
 * a `value` that was itself an object would blow up down in the SQL
 * layer. Only primitives are valid cursor values. They're compared
 * against a single orderable column.
 */
function decodeCursor(cursor: string): CursorPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const { value, op } = parsed as Partial<CursorPayload>;

  if (op !== "after" && op !== "before") {
    return undefined;
  }

  if (value === undefined || value === null) {
    return undefined;
  }

  // Restored before the generic object rejection below, which exists to
  // refuse a structured value as a cursor.
  if (isTaggedBigint(value)) {
    try {
      return { value: BigInt(value.$bigint), op };
    } catch {
      return undefined;
    }
  }

  if (typeof value === "object") {
    return undefined;
  }

  return { value, op };
}

/**
 * Coerce a caller-supplied page size into a usable integer.
 *
 * `perPage` typically originates from a query string (`?per_page=`), so a
 * zero, negative or fractional value is a client mistake rather than a
 * meaningful request. Left alone, `perPage <= 0` produced `LIMIT 1`/
 * `LIMIT 0`-style queries that returned an empty page, indistinguishable
 * from "this list really is empty".
 *
 * Only the LOWER bound is enforced here: a maximum page size is an
 * application policy (how much data one response may carry), not
 * something the paginator can pick for every app, so callers that need a
 * ceiling clamp before calling.
 */
function normalizePerPage(perPage: number): number {
  if (!Number.isFinite(perPage)) {
    return 1;
  }

  return Math.max(1, Math.floor(perPage));
}
