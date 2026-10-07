# Pagination

Three paginators, each a standalone function taking an `EloquentBuilder`,
each also available as a static shortcut on `Model`.

| Function | `Model` shortcut | Extra query | Can jump to page N | Correct at depth |
|---|---|---|---|---|
| `paginate()` | `Model.paginate()` | `COUNT(*)` | ✓ | ✗ |
| `simplePaginate()` | `Model.simplePaginate()` | none | ✗ | ✗ |
| `cursorPaginate()` | `Model.cursorPaginate()` | none | ✗ | ✓ |

## Choosing one

**`paginate()`** when the UI shows page numbers or a total, an admin
table, a "1 234 results" header. Costs one extra `COUNT(*)` per request,
and `OFFSET` degrades on deep pages.

**`simplePaginate()`** when you only need next/prev. Same offset
mechanics, but it skips the count by over-fetching one row. Right once a
table is large enough that `COUNT(*)` over the filtered set is a real
cost and nobody reads the total anyway.

**`cursorPaginate()`** for infinite-scroll feeds and API list endpoints.
Fast at any depth and immune to the shifting-results problem, at the cost
of no page numbers and a unique-monotonic-column requirement.

The shifting-results problem is worth understanding, because it's the
usual reason to use cursors. With offset paging, if rows are
inserted at the top of the ordering between two page loads, page 2 begins
where page 1 *used to* end, so the reader sees a row twice. Deletions
cause the mirror-image problem: a row is skipped entirely. Cursor paging
anchors on a value rather than a position, so neither happens.

## `paginate()`

```ts
import { paginate } from "@mahiframework/database";

const page = await paginate(Post.query().where("published", 1), 1, 20);
const page = await Post.paginate(1, 20);   // equivalent, unfiltered
```

```ts
interface LengthAwarePaginationResult<T> {
  data: Collection<T>;
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}
```

`total` is the full matching row count, `totalPages` is
`Math.ceil(total / perPage)`, and `hasMore` is `page < totalPages`.

Two queries, issued concurrently via `Promise.all`:

```ts
const [data, total] = await Promise.all([
  builder.limit(perPage).offset((page - 1) * perPage).get(),
  builder.count(),
]);
```

### Why the count is correct

`builder.count()` counts rows matching the accumulated `where()`
conditions and **deliberately ignores `orderBy`, `limit` and `offset`**.
That's what makes `total` the total across all pages even though the same
builder object also carries a page-sized `limit`/`offset` for the data
fetch. It mirrors Laravel's `getCountForPagination()`.

The two queries are not atomic. A concurrent insert between them can make
`total` disagree with what `data` contains. For a paginated list that's
almost never worth solving; if it is, wrap the call in a transaction.

`count()` *does* honour `groupBy`/`having`/`distinct`/`union`, by wrapping
the query as a subquery, so `paginate()` on a grouped or distinct query
reports the number of groups/distinct rows, which is what the pages
actually contain.

### `page` and `perPage` are clamped

Both are forced to whole numbers `>= 1`:

```ts
await Post.paginate(0, 20);    // page 1
await Post.paginate(-5, 20);   // page 1
await Post.paginate(1, 0);     // perPage 1
await Post.paginate(NaN, 20);  // page 1
```

These values almost always come straight off a query string, and the
arithmetic is unforgiving: `(page - 1) * perPage` is a **negative
`OFFSET`** for any page below 1, which Postgres rejects outright and MySQL
treats as a syntax error, turning a junk query param into a 500.
Clamping (rather than throwing) matches Laravel and makes a bad link a
harmless first page. `simplePaginate()` and `cursorPaginate()` do the
same.

The returned `page`/`perPage` are the clamped values, so a UI rendering
them shows what was actually served.

### `paginate()` mutates the builder

```ts
const builder = Post.query().where("published", 1);
const page1 = await paginate(builder, 1, 20);   // LIMIT 20 OFFSET 0
const page2 = await paginate(builder, 2, 20);   // LIMIT 20 OFFSET 20 — works by luck
```

`limit()` and `offset()` overwrite their previous values, so re-calling
happens to work, but any `orderBy` accumulated in between is *added*, not
replaced. Don't reuse a builder across paginator calls. Build a fresh one
per request, or `clone()`.

`simplePaginate()` and `cursorPaginate()` mutate too, `cursorPaginate()`
additionally appends an `orderBy` and, when a cursor is present, a
`where`.

## `simplePaginate()`

```ts
import { simplePaginate } from "@mahiframework/database";

const page = await simplePaginate(Post.query(), 1, 20);
const page = await Post.simplePaginate(1, 20);
```

```ts
interface SimplePaginationResult<T> {
  data: Collection<T>;
  page: number;
  perPage: number;
  hasMore: boolean;
}
```

No `total`, no `totalPages`. That's the point.

One query. It fetches `perPage + 1` rows, infers `hasMore` from whether
the extra row came back, and trims it off `data`:

```ts
const rows = await builder.limit(perPage + 1).offset((page - 1) * perPage).get();
const hasMore = rows.count() > perPage;
const data = hasMore ? Collection.make(rows.toArray().slice(0, perPage)) : rows;
```

Note that `simplePaginate()` does **not** normalise `perPage`. A zero or
negative value produces a nonsense `LIMIT`. Clamp before calling. See
[Clamping `perPage`](#clamping-perpage).

## `cursorPaginate()`

```ts
import { cursorPaginate } from "@mahiframework/database";

const result = await cursorPaginate(Post.query().whereNull("parent_id"), {
  column: "id",
  perPage: 20,
  cursor,
  direction: "desc",
});
```

```ts
interface CursorPaginateOptions<T, K extends keyof T & string> {
  column: K;                      // the sort/cursor column
  direction?: "asc" | "desc";     // defaults to "asc"
  perPage: number;
  cursor?: string | null;         // from a previous nextCursor/prevCursor
}

interface CursorPaginationResult<T> {
  data: Collection<T>;
  nextCursor: string | null;
  prevCursor: string | null;
}
```

One query. `perPage + 1` rows are fetched to detect whether another page
exists; the extra is trimmed.

### The cursor column must be unique and monotonic

**This is a hard requirement, not a recommendation.** The whole mechanism
is `WHERE column > lastSeenValue`. If two rows share a value, the boundary
comparison can't distinguish them, and you get skipped or repeated rows.

Compound cursors, tie-breaking on a second column, are not supported.

In practice this means the primary key, and it means a **time-sortable**
one. A `keyType: "uuid"` primary key is a v4 UUID, pure entropy, so it
sorts in random order, which makes the pages meaningless. Use
`keyType: "uuidv7"` instead:

```ts
import { Model, uuidv7 } from "@mahiframework/database";

interface PostAttributes {
  id: string;
  title: string;
}

export class Post extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
  keyType: uuidv7(),
  softDeletes: true,
}) {}
```

A UUID v7 is a 48-bit millisecond timestamp followed by entropy, so
`cursorPaginate({ column: "id", direction: "desc" })` pages newest-first
with no separate `created_at` ordering and no tie-breaking.

An auto-increment integer primary key works equally well. A `created_at`
timestamp works **only** if you can guarantee no two rows share one,
usually you can't.

### Cursor encoding

A cursor is base64url of `JSON.stringify({ value, op })`:

```ts
interface CursorPayload {
  value: unknown;
  op: "after" | "before";
}
```

```ts
function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}
```

base64url, not standard base64, so cursors are URL-safe without escaping.

It is **opaque, not secret**. Anyone can decode it and see the boundary
value. Don't put anything sensitive in the cursor column.

### Why `op` is in the payload

Walking backward requires a reversed query: flip the `orderBy`, flip the
comparison operator, then reverse the fetched rows before returning. You
cannot infer which direction a given cursor should walk from the cursor
value alone, so the direction is encoded in the cursor itself:

- **`nextCursor`** is always an `"after"` cursor built from the current
  page's **last** row.
- **`prevCursor`** is always a `"before"` cursor built from the current
  page's **first** row.
- Consuming a `"before"` cursor runs the query reversed, over-fetches to
  detect whether a page really precedes this one, then reverses `data`
  back into the canonical `direction` before returning.

The `hasNext`/`hasPrev` logic follows from that:

```ts
const hasNext = walkingBackward ? true : hasExtra;
const hasPrev = walkingBackward ? hasExtra : decoded !== undefined;
```

Walking backward implies a subsequent page exists *by construction*. You
walked backward from it. Walking forward from an explicit cursor implies a
preceding page exists for the same reason. In each case the other side is
what the `+1` over-fetch detects.

A consequence: on the **first** page (no cursor), `prevCursor` is `null`,
which is correct. But `hasPrev` for a forward walk is `decoded !==
undefined`, so any non-first forward page reports a `prevCursor` even if
the preceding page is empty. That's the right trade. Checking would cost
a query.

### `decodeCursor()` never throws

Cursors arrive straight off a query string, so they're untrusted input.
Decoding is total: **anything that isn't a cursor we produced is treated
as "no cursor", and the caller gets the first page.**

```ts
function decodeCursor(cursor: string): CursorPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

  const { value, op } = parsed as Partial<CursorPayload>;
  if (op !== "after" && op !== "before") return undefined;
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object") return undefined;

  return { value, op };
}
```

This is defensive for concrete reasons, each a bug that actually shipped:

- A bare `JSON.parse()` meant `?cursor=garbage` raised a `SyntaxError` that
  fell through the HTTP error handler as a **500** on every paginated
  endpoint. A client typo crashing the request.
- A payload decoding to a non-object (`[]`, `"str"`) or missing `value`
  sailed through as a real cursor and produced a silently **empty page**,
  indistinguishable from "this list is empty".
- A `value` that was itself an object blew up down in the SQL layer.

Only primitives are valid cursor values; they're compared against a single
orderable column.

**The user-visible consequence:** a malformed cursor silently returns page
one rather than erroring. If your client needs to distinguish "bad cursor"
from "start of list", validate it before calling.

### `normalizePerPage()` clamps the lower bound only

```ts
function normalizePerPage(perPage: number): number {
  if (!Number.isFinite(perPage)) return 1;
  return Math.max(1, Math.floor(perPage));
}
```

`perPage` typically comes from `?per_page=`, so zero, negative and
fractional values are client mistakes. Left alone, `perPage <= 0` produced
`LIMIT 1`/`LIMIT 0`-shaped queries returning an empty page,
indistinguishable from "this list really is empty".

**Only the lower bound is enforced.** A maximum page size is an
application policy, how much data one response may carry, not something
a paginator can pick for every app. Left uncapped, `?per_page=999999`
returns the entire table in one response.

Note that `paginate()` and `simplePaginate()` don't normalise at all.
Clamp before calling, always.

### Clamping `perPage`

Put the policy in one place and route every list endpoint through it:

```ts
// src/support/pagination.ts
import type { Request } from "@mahiframework/http";

export const DEFAULT_PER_PAGE = 20;
export const MAX_PER_PAGE = 100;

export function perPageFrom(request: Request): number {
  const requested = request.integer("per_page");
  if (requested === undefined) return DEFAULT_PER_PAGE;
  return Math.min(MAX_PER_PAGE, Math.max(1, requested));
}
```

## A complete controller

```ts
import { Controller, HttpResponse, type Request } from "@mahiframework/http";
import { cursorPaginate } from "@mahiframework/database";
import { Post } from "../../models/post.model.js";
import { PostResource } from "../resources/post.resource.js";
import { loadPosts } from "../../support/load-posts.js";
import { perPageFrom } from "../../support/pagination.js";

export class ListPostsController extends Controller {
  async handle(request: Request) {
    const perPage = perPageFrom(request);
    const cursor = request.query("cursor") ?? null;

    const builder = Post.query().whereNull("parent_id");

    const result = await cursorPaginate(builder, {
      column: "id",
      perPage,
      cursor,
      direction: "desc",
    });

    const loaded = await loadPosts(result.data.toArray());

    return HttpResponse.json({
      data: await PostResource.collection(loaded),
      nextCursor: result.nextCursor,
      prevCursor: result.prevCursor,
    });
  }
}
```

Note the relation loading happens **after** pagination, via `loadMany()`
(inside `loadPosts()`), not via `with()` on the builder. Either works,
`with()` runs during `get()`, which `cursorPaginate()` calls internally,
but loading afterwards is often clearer when the page needs aggregate
counts or per-user flags alongside relations, since those can't come from
`with()` at all.

See [Relationships](../relationships/#eager-loading).

## HTTP envelopes

`@mahiframework/http` provides two helpers that transform a paginator result
through a `Resource` while preserving the metadata.

### `paginatedResource()`

```ts
import { paginatedResource } from "@mahiframework/http";

const page = await Post.paginate(1, 20);
return HttpResponse.json(await paginatedResource(PostResource, page));
```

```json
{
  "data": [ /* ... */ ],
  "page": 1,
  "perPage": 20,
  "total": 137,
  "totalPages": 7,
  "hasMore": true
}
```

| Option | Effect |
|---|---|
| `additional` | Extra top-level fields merged in, Laravel's `->additional([...])`. |
| `nestMeta` | Nest the metadata under `meta` instead of spreading it. |

```ts
await paginatedResource(PostResource, page, { nestMeta: true });
```

```json
{
  "data": [ /* ... */ ],
  "meta": { "page": 1, "perPage": 20, "total": 137, "totalPages": 7, "hasMore": true }
}
```

### `cursorPaginatedResource()`

```ts
import { cursorPaginatedResource } from "@mahiframework/http";

const result = await Post.cursorPaginate({ column: "id", perPage: 20, cursor });
return HttpResponse.json(await cursorPaginatedResource(PostResource, result));
```

```json
{
  "nextCursor": "eyJ2YWx1ZSI6IjQyNzE4NTk2Njc0MzU2MDQ1NiIsIm9wIjoiYWZ0ZXIifQ",
  "prevCursor": null,
  "data": [ /* ... */ ]
}
```

Takes `additional` too. There is no `nestMeta`. There are only two
metadata fields.

Both helpers `await` every resource's `toJson()` in parallel via
`Promise.all`, so an async resource (one that calls a gate, say) doesn't
serialize the page sequentially.

There is no envelope helper for `simplePaginate()`. Build it inline:

```ts
const page = await Post.simplePaginate(pageNumber, perPage);
return HttpResponse.json({
  data: await PostResource.collection(page.data.toArray()),
  page: page.page,
  perPage: page.perPage,
  hasMore: page.hasMore,
});
```

See [Responses](../responses/) for resources.

## `Model` shortcuts

```ts
await Post.paginate(1, 20);
await Post.simplePaginate(1, 20);
await Post.cursorPaginate({ column: "id", perPage: 20, cursor });
```

Each proxies to the standalone function with `this.query()`, so global
scopes apply, but there's nowhere to add a `where`. For anything filtered,
call the standalone function with a builder.

Note these three statics are declared over a loose `Record<string, any>`
row rather than the model's instance type, so you may need a cast when
passing the result somewhere expecting instances. `data` really does
contain live model instances, `EloquentBuilder.get()` hydrates before the
paginator sees the rows. Calling the standalone `paginate(builder, …)`
functions with `Model.query()` keeps the precise instance type.

## Testing pagination

The things worth asserting, in rough priority order:

```ts
it("does not repeat rows across cursor pages", async () => {
  await Post.factory().times(50).create();

  const seen = new Set<string>();
  let cursor: string | null = null;

  do {
    const page = await Post.cursorPaginate({ column: "id", perPage: 10, cursor });
    for (const post of page.data) {
      expect(seen.has(post.id)).toBe(false);
      seen.add(post.id);
    }
    cursor = page.nextCursor;
  } while (cursor !== null);

  expect(seen.size).toBe(50);
});

it("returns the first page for a garbage cursor", async () => {
  const first = await Post.cursorPaginate({ column: "id", perPage: 10 });
  const garbage = await Post.cursorPaginate({ column: "id", perPage: 10, cursor: "not-a-cursor" });

  expect(garbage.data.first()!.id).toBe(first.data.first()!.id);
});

it("clamps a nonsense perPage to at least one row", async () => {
  await Post.factory().times(3).create();
  const page = await Post.cursorPaginate({ column: "id", perPage: 0 });
  expect(page.data.count()).toBe(1);
});
```

See [Testing](../testing/).
