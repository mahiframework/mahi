import { sql, type ExpressionBuilder, type Kysely, type SelectQueryBuilder } from "kysely";
import { Expression } from "./expression.js";
import { applyWhen } from "./conditionable.js";
import { DateTime } from "@mahiframework/datetime";
import { dialectOf } from "./drivers/dialect-registry.js";
import { normalizeBinding, normalizeBindings, type Bindable } from "./bindings.js";
import { queryGrammarFor, type JsonColumn, type QueryGrammar } from "./query/index.js";

export type WhereOperator = "=" | "!=" | ">" | ">=" | "<" | "<=" | "like" | "is" | "is not";

/**
 * The set of value types this framework's drivers accept as a SQL
 * parameter binding, what a `?` placeholder in a compiled query is
 * actually filled with, and therefore what `getBindings()` reports.
 *
 * This is the type at the *bottom* of the value pipeline, after
 * normalisation. Callers are not held to it: a `where()` comparand, a
 * `whereRaw()` binding and a write payload all accept the wider
 * `Bindable` (see `bindings.ts`), which additionally admits `DateTime`,
 * `Date` and model instances. `normalizeBinding()` reduces those to this
 * set during compilation, so everything below that point, Kysely,
 * `pg`/`mysql2`/`better-sqlite3`, only ever sees a value it can bind.
 *
 * `bigint` is in the set rather than normalised away: it is what a
 * 64-bit column reads back as, all three drivers bind it natively, and
 * narrowing it to a `number` would round any id past
 * `Number.MAX_SAFE_INTEGER` into a query for a different row.
 */
export type SqlBinding = string | number | boolean | bigint | null;

/**
 * The trailing arguments of a `where(column, ...)`-shaped method once the
 * leading column/callback has been resolved, either `[operator, value]`
 * (`where("price", ">", 5)`) or just `[value]` (`where("price", 5)`,
 * implicitly `"="`), matching Laravel's own two-or-three-argument
 * `where()` convention.
 */
export type WhereArgs<
  TRow extends Record<string, any>,
  K extends keyof TRow & string = keyof TRow & string,
> = [operator: WhereOperator, value: TRow[K]] | [value: TRow[K]];

/**
 * The trailing arguments of a `whereDate()`/`whereDay()`/`whereMonth()`/
 * `whereYear()`/`whereTime()`-shaped method, either `[operator, value]`
 * or just `[value]` (implicitly `"="`), parameterized over each method's
 * own accepted value type `V` (`string | Date` for `whereDate`/
 * `whereTime`, `string | number | Date` for `whereDay`/`whereMonth`/
 * `whereYear`).
 */
export type DateWhereArgs<V> = [operator: WhereOperator, value: V] | [value: V];

/** The trailing arguments of `whereJsonLength()`/`orWhereJsonLength()`, either `[operator, value]` or just `[value]` (implicitly `"="`). */
export type JsonLengthArgs = [operator: WhereOperator, value: number] | [value: number];

/**
 * A callback used anywhere Laravel accepts a `Closure` in place of a
 * value list or scalar (`whereIn`, `whereExists`, ...), receives a
 * fresh, unbound `QueryBuilder` (this framework's `Query\Builder`
 * equivalent, matching Laravel's `forSubQuery()`) to mutate directly:
 *
 *   builder.whereIn("id", (q) => q.table("post_hashtag").select("post_id").where("hashtag_id", tagId));
 *
 * No Kysely syntax is ever exposed here, `table()` replaces Kysely's
 * `selectFrom()`, `select()` replaces column projection, and every
 * other `QueryBuilder` method (`where()`, `whereColumn()`, ...) works
 * exactly as it does on a top-level query. The callback's return value
 * is ignored (matching Laravel, whose subquery closures mutate the
 * passed-in builder rather than returning a new one); the passed-in
 * builder's final state is what gets compiled.
 */
export type SubqueryFactory = (query: QueryBuilder<Record<string, any>>) => void;

/**
 * Everything `whereIn()`/`whereExists()` (and friends) accept in place of
 * a value list, a `SubqueryFactory` closure, an already-built
 * `QueryBuilder` (e.g. `Related.query().toBase()`), or a raw `Expression`
 * (`Expression.raw(...)`, this framework's `DB::raw()` port, see
 * `expression.ts`), matching Laravel's own `whereIn($column, $values)`
 * accepting a `Closure|Builder|Expression`.
 */
export type Subquery = SubqueryFactory | QueryBuilder<any> | Expression;

/**
 * Compiles a `Subquery` value into the Kysely expression `eb(...)`/
 * `eb.exists(...)` compile against, the one place this file still
 * touches Kysely internals to bridge a `QueryBuilder`/`Expression` into
 * a Kysely-compiled subquery.
 *
 * A `QueryBuilder`'s own `buildSelect()` already compiles to a
 * `SelectQueryBuilder`, which Kysely parenthesizes correctly wherever
 * it's used as an `IN`/`EXISTS` operand. A raw `Expression`, though, is
 * just an unparenthesized SQL fragment the user wrote by hand (`select
 * ...` with no wrapping), explicitly wrapped in `(...)` here so it's
 * valid in both positions, matching what `QueryBuilder`'s own compiled
 * subqueries already produce.
 */
function compileSubquery(resolveConnection: () => Kysely<any>, subquery: Subquery): any {
  if (subquery instanceof Expression) {
    return sql`(${subquery.toKysely()})`;
  }

  if (subquery instanceof QueryBuilder) {
    return (subquery as any).buildSelect();
  }

  const nested = new QueryBuilder<Record<string, any>>(resolveConnection, "");
  subquery(nested);

  return (nested as any).buildSelect();
}

/** The boolean connector joining a where node to whatever precedes it, matching Laravel's per-clause `$boolean`. */
type Connector = "and" | "or";

interface BasicWhereNode {
  type: "basic";
  connector: Connector;
  not: boolean;
  column: string;
  operator: WhereOperator;
  value: Bindable;
}

interface InWhereNode {
  type: "in";
  connector: Connector;
  not: boolean;
  column: string;
  values: Bindable[] | Subquery;
}

interface NullWhereNode {
  type: "null";
  connector: Connector;
  not: boolean;
  column: string;
}

interface BetweenWhereNode {
  type: "between";
  connector: Connector;
  not: boolean;
  column: string;
  min: Bindable;
  max: Bindable;
}

interface ColumnWhereNode {
  type: "column";
  connector: Connector;
  not: boolean;
  first: string;
  operator: WhereOperator;
  second: string;
  /**
   * `second` names a column in the ENCLOSING query, not this one, set
   * by the correlated-existence builders in `EloquentBuilder`.
   *
   * `alias()` rewrites `{table}.col` to `{alias}.col` so a subquery's
   * own predicates follow it when it is aliased. That rewrite must not
   * touch the outer reference, and normally can't: the two sides name
   * different tables. In a SELF-referential relation they name the same
   * one, so the outer half would be rewritten to the subquery's alias
   * and the predicate would compare the subquery's row to itself,
   * `whereHas("replies")` matching everything or nothing rather than
   * correlating. The flag is the only thing that distinguishes them.
   */
  secondIsOuter?: boolean;
}

interface ExistsWhereNode {
  type: "exists";
  connector: Connector;
  not: boolean;
  subquery: Subquery;
}

interface RawWhereNode {
  type: "raw";
  connector: Connector;
  sqlText: string;
  bindings: Bindable[];
}

interface GroupWhereNode {
  type: "group";
  connector: Connector;
  not: boolean;
  nested: WhereNode[];
}

/**
 * `whereDate`/`whereDay`/`whereMonth`/`whereYear`/`whereTime`, the
 * component extracted from a date/time column. Each engine spells the
 * extraction differently (`strftime()`, `year()`, `extract()`), so the
 * node stores only which component was asked for and the active
 * `QueryGrammar` turns it into SQL. See `query/grammar.ts`.
 */
type DatePart = "date" | "day" | "month" | "year" | "time";

interface DatePartWhereNode {
  type: "datePart";
  connector: Connector;
  part: DatePart;
  column: string;
  operator: WhereOperator;
  value: string;
}

/** `whereJsonContains`/`whereJsonContainsKey`/`whereJsonLength`. See the class docstring's "JSON where helpers" section. */
interface JsonContainsWhereNode {
  type: "jsonContains";
  connector: Connector;
  not: boolean;
  column: string;
  value: Bindable;
}

interface JsonContainsKeyWhereNode {
  type: "jsonContainsKey";
  connector: Connector;
  not: boolean;
  column: string;
}

interface JsonLengthWhereNode {
  type: "jsonLength";
  connector: Connector;
  column: string;
  operator: WhereOperator;
  value: number;
}

export type WhereNode =
  | BasicWhereNode
  | InWhereNode
  | NullWhereNode
  | BetweenWhereNode
  | ColumnWhereNode
  | ExistsWhereNode
  | RawWhereNode
  | GroupWhereNode
  | DatePartWhereNode
  | JsonContainsWhereNode
  | JsonContainsKeyWhereNode
  | JsonLengthWhereNode;

interface OrderClause {
  kind: "column";
  column: string;
  direction: "asc" | "desc";
}

interface RawOrderClause {
  kind: "raw";
  sqlText: string;
  bindings: Bindable[];
}

/** `inRandomOrder()`, the function differs per engine, so the node records only the intent. */
interface RandomOrderClause {
  kind: "random";
}

/** A `selectRaw()` projection, a hand-written SQL fragment with `?` bindings. */
interface RawSelectEntry {
  kind: "raw";
  sqlText: string;
  bindings: Bindable[];
}

/**
 * A `(select count(*) from ...) as alias` projection built from another
 * `QueryBuilder`, what `EloquentBuilder.withCount()` adds.
 *
 * Held as the builder itself rather than pre-compiled SQL so it is
 * embedded as a real Kysely subquery at execution time. Compiling it to
 * a string and re-parsing it through `selectRaw()` would break on any
 * engine whose placeholders aren't `?`: Postgres compiles bindings to
 * `$1`, which `buildRawSqlExpression()` then cannot match against the
 * bindings it was handed.
 */
interface CountSelectEntry {
  kind: "count";
  subquery: QueryBuilder<any>;
  alias: string;
}

type SelectEntry = RawSelectEntry | CountSelectEntry;

type OrderEntry = OrderClause | RawOrderClause | RandomOrderClause;

/** A `HAVING` clause, either a basic `column operator value` or a raw SQL fragment. See `QueryBuilder.having()`/`havingRaw()`. */
interface BasicHavingNode {
  kind: "basic";
  connector: Connector;
  column: string;
  operator: WhereOperator;
  value: Bindable;
}

interface RawHavingNode {
  kind: "raw";
  connector: Connector;
  sqlText: string;
  bindings: Bindable[];
}

type HavingNode = BasicHavingNode | RawHavingNode;

/** Which `JOIN` keyword a `JoinNode` compiles to. See `QueryBuilder.join()`. */
type JoinType = "inner" | "left" | "cross";

/**
 * One condition inside a join's `ON` clause. `kind: "value"` compares a
 * column against a bound value (`on("taggables.taggable_type", "post")`),
 * `kind: "ref"` compares two columns (`onRef("taggables.tag_id", "=",
 * "tags.id")`), the same split `where()`/`whereColumn()` already make on
 * the where side, carried into the join.
 */
interface JoinOnNode {
  connector: Connector;
  kind: "value" | "ref";
  first: string;
  operator: WhereOperator;
  second: Bindable | string;
}

interface JoinNode {
  type: JoinType;
  /** The joined table, optionally aliased (`"posts as parent"`). */
  table: string;
  ons: JoinOnNode[];
}

/**
 * The `ON`-clause accumulator handed to `join(table, callback)`, mirrors
 * the where-tree design (each node carries its own `and`/`or` connector,
 * compiled into one Kysely expression at execution time) so a multi-
 * condition join reads the same way a grouped `where()` does:
 *
 *   query.join<TaggablePivot>("taggables", (j) =>
 *     j.onRef("taggables.tag_id", "=", "tags.id")
 *      .on("taggables.taggable_type", "post"),
 *   );
 *   // inner join "taggables" on "taggables"."tag_id" = "tags"."id"
 *   //                       and "taggables"."taggable_type" = ?
 *
 * Deliberately narrower than Laravel's `JoinClause` (which is a full
 * `Query\Builder` and accepts every `where*()` method): `on`/`orOn` cover
 * value comparisons, `onRef`/`orOnRef` cover column comparisons, and
 * anything beyond that belongs in the outer `where()`, a join predicate
 * complex enough to need `whereIn`/`whereExists` is a filter, not a join.
 */
export class JoinClause {
  /** @internal, read by `QueryBuilder.applyJoins()`. */
  readonly ons: JoinOnNode[] = [];

  /** `ON first = value`, a bound value comparison. Two-argument form implies `"="`. */
  on(first: string, operator: WhereOperator, value: Bindable): this;
  on(first: string, value: Bindable): this;
  on(first: string, ...args: [WhereOperator, Bindable] | [Bindable]): this {
    return this.push("and", "value", first, args);
  }

  /** `on()` joined with `OR`. */
  orOn(first: string, operator: WhereOperator, value: Bindable): this;
  orOn(first: string, value: Bindable): this;
  orOn(first: string, ...args: [WhereOperator, Bindable] | [Bindable]): this {
    return this.push("or", "value", first, args);
  }

  /** `ON first = second` where both sides are **columns**, the ordinary join predicate. */
  onRef(first: string, operator: WhereOperator, second: string): this {
    this.ons.push({ connector: "and", kind: "ref", first, operator, second });

    return this;
  }

  /** `onRef()` joined with `OR`. */
  orOnRef(first: string, operator: WhereOperator, second: string): this {
    this.ons.push({ connector: "or", kind: "ref", first, operator, second });

    return this;
  }

  private push(
    connector: Connector,
    kind: "value",
    first: string,
    args: [WhereOperator, Bindable] | [Bindable],
  ): this {
    const [operator, second] = args.length === 2 ? args : (["=", args[0]] as const);
    this.ons.push({ connector, kind, first, operator, second: second as Bindable });

    return this;
  }
}

/**
 * Compiles one `ON` node into a Kysely expression, the join-side twin
 * of `compileNode()`.
 *
 * `normalize` is passed in rather than resolved here because this is a
 * free function with no connection to read a dialect from; the caller
 * (`applyJoins()`) has one. A `ref` node compares two columns, so it
 * has no value to normalize.
 */
function compileJoinOn(
  eb: ExpressionBuilder<any, any>,
  node: JoinOnNode,
  normalize: (value: unknown) => any,
): any {
  return node.kind === "ref"
    ? eb(node.first, node.operator as any, eb.ref(node.second as string))
    : eb(node.first, node.operator as any, normalize(node.second));
}

/** Folds a join's `ON` nodes into one expression, honoring each node's own `and`/`or` connector. */
function compileJoinOns(
  eb: ExpressionBuilder<any, any>,
  nodes: JoinOnNode[],
  normalize: (value: unknown) => any,
): any {
  let result = compileJoinOn(eb, nodes[0]!, normalize);

  for (let i = 1; i < nodes.length; i++) {
    const node = nodes[i]!;
    const expr = compileJoinOn(eb, node, normalize);
    result = node.connector === "or" ? eb.or([result, expr]) : eb.and([result, expr]);
  }

  return result;
}

/** A `UNION`/`UNION ALL` operand. See `QueryBuilder.union()`. */
interface UnionNode {
  subquery: Subquery;
  all: boolean;
}

/**
 * Splits a Laravel-style `"json_col->nested->path"` column reference
 * into the base column and its path segments, mirrors Laravel's own
 * `CompilesJsonPaths::wrapJsonFieldAndPath()`, simplified (no bracket/
 * array-index segment support, which none of this framework's JSON
 * where helpers need yet).
 *
 * The segments stay a list rather than being joined into a `$.a.b`
 * path string here because the engines do not agree on the spelling:
 * SQLite and MySQL take that JSONPath string, Postgres chains `->`
 * operators instead. Each `QueryGrammar` formats them itself.
 */
function splitJsonColumn(column: string): JsonColumn {
  const [field, ...segments] = column.split("->");

  return { field: field!, segments };
}

/**
 * Formats a `DateTime` into the string shape `whereDate`/`whereDay`/etc.
 * compare against, **read in UTC**.
 *
 * The zone is the whole point. These predicates compare against a
 * calendar field the *database* extracts from a stored value, and the
 * framework only ever stores UTC, so `whereDate("created_at",
 * DateTime.now())` from a machine in Perth must compare against the UTC
 * date, not the local one. Without the conversion, every query run
 * between midnight and 08:00 local would silently ask for the wrong day.
 */
function formatDateTimePart(part: DatePart, value: DateTime): string {
  const utc = value.setTimezone("UTC");

  switch (part) {
    case "date":
      return utc.format("yyyy-MM-dd");
    case "time":
      return utc.format("HH:mm:ss");
    case "day":
      return utc.format("dd");
    case "month":
      return utc.format("MM");
    case "year":
      return utc.format("yyyy");
  }
}

/** Formats a `Date` into the string shape `whereDate`/`whereDay`/etc. compare against, matching Laravel's own per-part `DateTimeInterface::format()` calls. */
function formatDatePart(part: DatePart, date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  switch (part) {
    case "date":
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    case "time":
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    case "day":
      return pad(date.getDate());
    case "month":
      return pad(date.getMonth() + 1);
    case "year":
      return String(date.getFullYear());
  }
}

/**
 * Splits a `?`-placeholder SQL string into the template fragments
 * `buildRawSqlExpression()` re-tags, treating a `?` as a placeholder
 * **only** when it is outside a quoted region and isn't part of a
 * multi-character operator.
 *
 * A naive `sqlText.split("?")` is wrong in three ways that all show up
 * in real queries:
 *
 *   where note like '%?%'            -- a literal question mark in a string
 *   where "tags" ? 'urgent'          -- Postgres JSON "has key" operator
 *   where "tags" ?| array['a','b']   -- ...and its ?| / ?& siblings
 *
 * Quoting handled: `'...'` (with `''` as the escaped quote, per SQL),
 * `"..."`/`` `...` `` identifiers, and `??` as the explicit escape for a
 * literal `?` outside quotes (which is what a caller writes when they
 * genuinely want the character and the heuristics can't know it).
 * Postgres' `?`/`?|`/`?&` are recognised by lookahead, matching how
 * Laravel's own `PostgresGrammar` special-cases them.
 */
function splitRawSqlPlaceholders(sqlText: string): { fragments: string[]; placeholders: number } {
  const fragments: string[] = [];
  let current = "";
  let quote: string | undefined;

  for (let i = 0; i < sqlText.length; i++) {
    const char = sqlText[i]!;

    if (quote !== undefined) {
      current += char;

      // A doubled quote inside a quoted region is an escaped quote, not
      // the end of it ('it''s', "a""b").
      if (char === quote) {
        if (sqlText[i + 1] === quote) {
          current += quote;
          i++;
        } else {
          quote = undefined;
        }
      }

      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }

    if (char === "?") {
      const next = sqlText[i + 1];

      // `??`, the caller's explicit escape for a literal `?`.
      if (next === "?") {
        current += "?";
        i++;
        continue;
      }

      // Postgres JSON operators `?|` and `?&`, an operator, not a bind.
      if (next === "|" || next === "&") {
        current += char + next;
        i++;
        continue;
      }

      fragments.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  fragments.push(current);

  return { fragments, placeholders: fragments.length - 1 };
}

/**
 * Builds a Kysely raw-SQL expression from a `?`-placeholder SQL string
 * and a positional bindings array (Laravel's `whereRaw()` convention),
 * by splitting the string into template fragments and re-tagging them
 * through Kysely's `sql` template tag so each binding is still sent as a
 * real parameter, never string-interpolated.
 *
 * See `splitRawSqlPlaceholders()` for which `?`s count as placeholders,
 * ones inside string/identifier quotes, `??` escapes and Postgres'
 * `?|`/`?&` JSON operators are not bind sites.
 */
function buildRawSqlExpression(sqlText: string, bindings: readonly unknown[]): any {
  const { fragments, placeholders } = splitRawSqlPlaceholders(sqlText);

  if (placeholders !== bindings.length) {
    throw new Error(
      `whereRaw(): ${bindings.length} binding(s) provided but the SQL has ${placeholders} "?" placeholder(s).`,
    );
  }

  return sql(fragments as unknown as TemplateStringsArray, ...bindings);
}

/**
 * Low-level, table-scoped query builder, mirrors Laravel's
 * `Illuminate\Database\Query\Builder`: no `Model` awareness at all, just
 * a table name + a lazily-resolved connection + accumulated where/order/
 * limit/offset state, executed on demand.
 *
 * Connection resolution is deferred to execution time (`get()`/`first()`/
 * `count()`/`insert()`/`update()`/`delete()`), not bound eagerly at
 * construction. `resolveConnection` is called fresh on every execution,
 * so a builder constructed inside a `transaction()` callback (via
 * `EloquentBuilder`/`Model`, whose `resolveConnection` checks the active
 * transaction context) picks up the transactional connection even though
 * the builder object itself was created before execution.
 *
 * Each chainable method **mutates `this` and returns `this`** (not a new
 * cloned instance), matches Laravel's Builder ergonomics
 * (`$query->where(...)` mutates `$query`), simpler than an immutable/
 * clone-per-call design, and consistent with `EloquentBuilder` wrapping
 * this class the same way.
 *
 * ## Where clauses
 *
 * Every `where*()` method pushes a node onto an internal tree (not a
 * flat list), each node carries its own `and`/`or` connector (Laravel's
 * `$boolean`) and, for `where(callback)`/`orWhere(callback)`, a nested
 * child list, compiled recursively into a single Kysely expression via
 * `eb.and()`/`eb.or()`/`eb.not()` at execution time. This is what makes
 * grouped conditions possible:
 *
 *   query.where("active", 1).where((q) =>
 *     q.where("role", "admin").orWhere("role", "owner")
 *   );
 *   // WHERE active = 1 AND (role = 'admin' OR role = 'owner')
 *
 * `whereIn()`'s second argument accepts either a plain value array or a
 * `Subquery` (a callback, a `QueryBuilder`, or an `Expression`),
 * matching real Laravel's `whereIn($column, $values)` overload (a
 * `Closure`/`Builder`/`Expression` compiles to a correlated subquery
 * instead of a value list). There is deliberately no separate
 * `whereInSubquery()` method name for this.
 *
 * ## Joins and unions
 *
 * `join()`/`leftJoin()`/`crossJoin()` widen the builder's row type rather
 * than fighting it: a join mixes columns from two tables, so the return
 * type is `QueryBuilder<TRow & TJoined>`, exactly what `selectRaw<TExtra>()`
 * already does for a raw aliased column. `leftJoin()` widens with
 * `Partial<TJoined>` instead, since an unmatched left row nulls every
 * joined column.
 *
 *   const rows = await DB.table("tags")
 *     .join<{ pivot_weight: number }>("taggables", (j) =>
 *       j.onRef("taggables.tag_id", "=", "tags.id").on("taggables.taggable_type", "post"),
 *     )
 *     .select("tags.*", "taggables.weight as pivot_weight")
 *     .get();
 *
 * `union()`/`unionAll()` append another query's rows to this one's. Both
 * sides must project a matching column set. This builder can't check
 * that (it has no schema), so it's the caller's responsibility, same as
 * Laravel.
 *
 * ## Non-goals (deliberate)
 *
 * No vector/full-text search operators, no
 * `whereRowValues`/`whereAll`/`whereAny`/`whereNone`, no `dynamicWhere()`
 * (magic `whereName()` methods, against this codebase's "no magic"
 * stance). `groupBy()`/`having()`/`havingRaw()` ARE supported (paired
 * with an aggregate `selectRaw()`); `countBy()` stays as single-call
 * sugar for the common "count per group" case.
 * `lock()`/`lockForUpdate()`/`sharedLock()` emit real `FOR UPDATE`/`FOR
 * SHARE` on MySQL and Postgres, and are documented no-ops on SQLite
 * (see `lock()`'s docstring). `.raw()` remains the escape hatch for
 * anything not covered.
 *
 * ## Dialects
 *
 * The builder itself is dialect-agnostic: it accumulates a tree of
 * nodes and lets Kysely spell the standard SQL. The handful of
 * constructs the engines genuinely disagree on, date-component
 * extraction, JSON containment/length, random ordering, upsert conflict
 * clauses, row locks, are delegated to a `QueryGrammar` resolved from
 * the connection at execution time (see `query/grammar.ts`), so the
 * same builder chain compiles correctly against SQLite, MySQL and
 * Postgres.
 */
export class QueryBuilder<TRow extends Record<string, any>> {
  private wheres: WhereNode[] = [];
  private orders: OrderEntry[] = [];
  private groups: string[] = [];
  private rawGroups: { sqlText: string; bindings: Bindable[] }[] = [];
  private havings: HavingNode[] = [];
  private limitValue?: number;
  private offsetValue?: number;
  private distinctValue = false;
  private lockValue?: boolean | string;
  private extraSelects: SelectEntry[] = [];
  private selectColumns?: string[];
  private joins: JoinNode[] = [];
  private unions: UnionNode[] = [];
  /** Set by `alias()`, kept apart from `tableName` so `qualify()` can rewrite real-table-qualified columns. */
  private tableAlias?: string;

  constructor(
    private resolveConnection: () => Kysely<any>,
    private tableName: string,
  ) {}

  /**
   * The `QueryGrammar` for whichever engine this builder's connection
   * talks to, the dialect-specific spellings of date extraction, JSON
   * predicates, random ordering, upserts and row locks.
   *
   * Resolved fresh from the connection on every call rather than cached
   * at construction, for the same reason `resolveConnection` is a thunk:
   * the connection is not known until a terminal runs (a builder built
   * outside a transaction may execute inside one), so neither is the
   * dialect.
   */
  private grammar(): QueryGrammar {
    return queryGrammarFor(dialectOf(this.resolveConnection()));
  }

  /**
   * One bound value converted to a shape the driver accepts, a
   * `DateTime`/`Date` to UTC text, a `bigint` to a key, a model instance
   * to its key. See `normalizeBinding()` for why each conversion exists.
   *
   * Applied at *compile* time rather than when the value is pushed onto
   * a node, for the same reason `grammar()` resolves late: the dialect
   * is not known until a connection is (and a `DateTime` is spelled
   * differently on MySQL). Compiling is also the point `toSql()`,
   * `getBindings()` and `toRawSql()` go through, so introspection
   * reports exactly the values the driver will receive rather than the
   * objects the caller passed.
   */
  private normalize(value: unknown): any {
    return normalizeBinding(dialectOf(this.resolveConnection()), value);
  }

  /** `normalize()` across a list, preserving the original array when nothing changed. */
  private normalizeList(values: readonly unknown[]): any[] {
    return normalizeBindings(dialectOf(this.resolveConnection()), values) as any[];
  }

  /**
   * `normalize()` across a write payload's values, returning the
   * original object when nothing needed changing so the common path
   * allocates nothing.
   *
   * This is the `insert()`/`update()`/`upsert()` counterpart to the
   * `where()` normalisation: `update({ published_at: DateTime.now() })`
   * has exactly the same driver problem as
   * `where("published_at", DateTime.now())`, and a `QueryBuilder` reached
   * through `DB.table()` has no model and therefore no casts to lean on.
   */
  private normalizeValues<T extends Record<string, any>>(values: T): T {
    const dialect = dialectOf(this.resolveConnection());
    let copy: Record<string, any> | undefined;

    for (const [column, value] of Object.entries(values)) {
      const normalized = normalizeBinding(dialect, value);

      if (normalized === value) {
        continue;
      }

      copy ??= { ...values };
      copy[column] = normalized;
    }

    return (copy as T) ?? values;
  }

  /**
   * Rebinds this builder to a different table. `DB.table(name)` is the
   * front door for *starting* a query (Laravel's `DB::table()`); this
   * method is for retargeting an existing builder, so a nested subquery
   * callback (`whereIn()`/`whereExists()`'s `Subquery` overload. See the
   * class docstring) can point at a different table than the outer query
   * without ever touching Kysely's `selectFrom()` directly:
   *
   *   builder.whereIn("id", (q) => q.table("post_hashtag").select("post_id").where("hashtag_id", tagId));
   *
   * Returns `QueryBuilder<Record<string, any>>` rather than `this`,
   * switching tables invalidates the original `TRow` typing (the new
   * table's columns aren't `TRow`'s), so `where()`/`select()` etc. widen
   * to accept arbitrary column names after a `table()` call, matching
   * how a fresh subquery builder (which has no table bound yet) behaves.
   */
  table(name: string): QueryBuilder<Record<string, any>> {
    this.tableName = name;

    return this as unknown as QueryBuilder<Record<string, any>>;
  }

  /**
   * Aliases this builder's table (`"posts as parent"`), Laravel's
   * `from($table, $as)`. Kysely's `selectFrom()` already accepts the
   * `"table as alias"` form, so `table("posts as parent")` works too;
   * this exists so the intent is explicit at call sites that *depend* on
   * the alias for correctness rather than readability.
   *
   * The critical case is a **self-referential** correlated subquery,
   * where the inner and outer query are the same table and a bare
   * `"posts"."parent_id" = "posts"."id"` would compare a row to itself:
   *
   *   base.alias("posts__sub").whereRaw(`"posts__sub"."parent_id" = "posts"."id"`)
   *
   * Clauses already accumulated that qualify a column with the **real
   * table name** are rewritten to the alias when they compile (see
   * `qualify()`). Aliasing is normally applied to an already-built
   * builder, `whereHas()` takes the related model's scoped `query()`
   * and *then* aliases it, so without that rewrite a global scope like
   * `SoftDeletes`, which must qualify its column to survive joins, would
   * emit `"posts"."deleted_at"` against a query whose only table is now
   * `posts__sub`. Bare (unqualified) columns are untouched: they resolve
   * against whatever the query's single table is, alias or not.
   *
   * `TRow` is unchanged, an alias renames the table, not its columns.
   */
  alias(name: string): this {
    this.tableAlias = name;

    return this;
  }

  /** The table this builder selects from, including any `alias()` suffix, used by correlation builders that need to qualify columns. */
  getTable(): string {
    return this.tableAlias === undefined
      ? this.tableName
      : `${this.tableName} as ${this.tableAlias}`;
  }

  /**
   * Rewrites a `{real table}.column` reference to `{alias}.column` on an
   * aliased builder. See `alias()`. A no-op with no alias set, and on
   * any column qualified by some *other* table (a joined one, or the
   * outer query in a correlated predicate), which must keep pointing
   * where it points.
   */
  private qualify(column: string): string {
    if (this.tableAlias === undefined) {
      return column;
    }

    const prefix = `${this.tableName}.`;

    return column.startsWith(prefix) ? `${this.tableAlias}.${column.slice(prefix.length)}` : column;
  }

  /**
   * Adds an `INNER JOIN`, widening the row type to `TRow & TJoined`.
   * See the class docstring's "Joins and unions" section. Pass `TJoined`
   * explicitly to describe the columns the join projects; it is NOT
   * inferred (this builder has no schema to read).
   *
   * Two forms, matching Laravel:
   *
   *   .join<Joined>("users", "posts.user_id", "users.id")        // simple column equality
   *   .join<Joined>("users", (j) => j.onRef(...).on(...))        // multi-condition
   *
   * `table` may be aliased (`"posts as parent"`), which is what makes a
   * self-join expressible.
   *
   * A join does not project the joined table's columns on its own,
   * `selectAll()` on a joined query returns every column from every
   * table, with duplicate names colliding. Pair a join with an explicit
   * `select("posts.*", "users.name as author_name")` whenever the two
   * tables share a column name.
   */
  join<TJoined extends Record<string, any> = Record<string, any>>(
    table: string,
    first: string,
    second: string,
  ): QueryBuilder<TRow & TJoined>;
  join<TJoined extends Record<string, any> = Record<string, any>>(
    table: string,
    on: (join: JoinClause) => void,
  ): QueryBuilder<TRow & TJoined>;
  join<TJoined extends Record<string, any> = Record<string, any>>(
    table: string,
    firstOrOn: string | ((join: JoinClause) => void),
    second?: string,
  ): QueryBuilder<TRow & TJoined> {
    return this.pushJoin("inner", table, firstOrOn, second) as QueryBuilder<TRow & TJoined>;
  }

  /**
   * Adds a `LEFT JOIN`, widening the row type to `TRow &
   * Partial<TJoined>`: the joined columns are `undefined` on any row
   * with no match, which `Partial` is the honest type for.
   */
  leftJoin<TJoined extends Record<string, any> = Record<string, any>>(
    table: string,
    first: string,
    second: string,
  ): QueryBuilder<TRow & Partial<TJoined>>;
  leftJoin<TJoined extends Record<string, any> = Record<string, any>>(
    table: string,
    on: (join: JoinClause) => void,
  ): QueryBuilder<TRow & Partial<TJoined>>;
  leftJoin<TJoined extends Record<string, any> = Record<string, any>>(
    table: string,
    firstOrOn: string | ((join: JoinClause) => void),
    second?: string,
  ): QueryBuilder<TRow & Partial<TJoined>> {
    return this.pushJoin("left", table, firstOrOn, second) as QueryBuilder<TRow & Partial<TJoined>>;
  }

  /** Adds a `CROSS JOIN`, no `ON` clause, every row paired with every row. */
  crossJoin<TJoined extends Record<string, any> = Record<string, any>>(
    table: string,
  ): QueryBuilder<TRow & TJoined> {
    this.joins.push({ type: "cross", table, ons: [] });

    return this as unknown as QueryBuilder<TRow & TJoined>;
  }

  private pushJoin(
    type: JoinType,
    table: string,
    firstOrOn: string | ((join: JoinClause) => void),
    second?: string,
  ): this {
    const clause = new JoinClause();

    if (typeof firstOrOn === "function") {
      firstOrOn(clause);
    } else {
      clause.onRef(firstOrOn, "=", second!);
    }

    this.joins.push({ type, table, ons: clause.ons });

    return this;
  }

  /**
   * Appends another query's rows to this one's, deduplicated,
   * Laravel's `union()`. Accepts the same `Subquery` shapes
   * `whereIn()`/`whereExists()` do (a callback, a built `QueryBuilder`,
   * or a raw `Expression`).
   *
   *   const rows = await DB.table("posts")
   *     .where("published", 1)
   *     .union((q) => q.table("drafts").where("author_id", userId))
   *     .get();
   *
   * Both sides must project the same column set in the same order. This
   * builder has no schema to verify that with, so a mismatch surfaces as
   * a database error, same as Laravel. `TRow` is unchanged: a union
   * appends rows, never columns.
   *
   * `orderBy()`/`limit()`/`offset()` on THIS builder apply to the
   * combined result (Kysely emits them after the union), matching SQL's
   * own semantics.
   */
  union(subquery: Subquery): this {
    this.unions.push({ subquery, all: false });

    return this;
  }

  /** `union()` keeping duplicate rows, Laravel's `unionAll()`. */
  unionAll(subquery: Subquery): this {
    this.unions.push({ subquery, all: true });

    return this;
  }

  where<K extends keyof TRow & string>(column: K, operator: WhereOperator, value: TRow[K]): this;
  where<K extends keyof TRow & string>(column: K, value: TRow[K]): this;
  where(callback: (query: QueryBuilder<TRow>) => void): this;
  where<K extends keyof TRow & string>(
    columnOrCallback: K | ((query: QueryBuilder<TRow>) => void),
    ...args: WhereArgs<TRow, K> | []
  ): this {
    return this.pushWhere("and", false, columnOrCallback, args);
  }

  orWhere<K extends keyof TRow & string>(column: K, operator: WhereOperator, value: TRow[K]): this;
  orWhere<K extends keyof TRow & string>(column: K, value: TRow[K]): this;
  orWhere(callback: (query: QueryBuilder<TRow>) => void): this;
  orWhere<K extends keyof TRow & string>(
    columnOrCallback: K | ((query: QueryBuilder<TRow>) => void),
    ...args: WhereArgs<TRow, K> | []
  ): this {
    return this.pushWhere("or", false, columnOrCallback, args);
  }

  whereNot<K extends keyof TRow & string>(column: K, operator: WhereOperator, value: TRow[K]): this;
  whereNot<K extends keyof TRow & string>(column: K, value: TRow[K]): this;
  whereNot(callback: (query: QueryBuilder<TRow>) => void): this;
  whereNot<K extends keyof TRow & string>(
    columnOrCallback: K | ((query: QueryBuilder<TRow>) => void),
    ...args: WhereArgs<TRow, K> | []
  ): this {
    return this.pushWhere("and", true, columnOrCallback, args);
  }

  orWhereNot<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: TRow[K],
  ): this;
  orWhereNot<K extends keyof TRow & string>(column: K, value: TRow[K]): this;
  orWhereNot(callback: (query: QueryBuilder<TRow>) => void): this;
  orWhereNot<K extends keyof TRow & string>(
    columnOrCallback: K | ((query: QueryBuilder<TRow>) => void),
    ...args: WhereArgs<TRow, K> | []
  ): this {
    return this.pushWhere("or", true, columnOrCallback, args);
  }

  private pushWhere<K extends keyof TRow & string>(
    connector: Connector,
    not: boolean,
    columnOrCallback: K | ((query: QueryBuilder<TRow>) => void),
    args: WhereArgs<TRow, K> | [],
  ): this {
    if (typeof columnOrCallback === "function") {
      const nested = new QueryBuilder<TRow>(this.resolveConnection, this.tableName);
      columnOrCallback(nested);
      this.wheres.push({ type: "group", connector, not, nested: nested.wheres });

      return this;
    }

    const [operator, value] = args.length === 2 ? args : (["=", args[0]] as const);
    this.wheres.push({
      type: "basic",
      connector,
      not,
      column: columnOrCallback,
      operator,
      value: value as Bindable,
    });

    return this;
  }

  /** Merges an externally-built where tree (e.g. from a nested `EloquentBuilder`) in as a single grouped node. */
  pushWhereGroup(connector: Connector, not: boolean, nested: WhereNode[]): this {
    this.wheres.push({ type: "group", connector, not, nested });

    return this;
  }

  /** Exposes the accumulated where tree, used by `EloquentBuilder` to merge nested-builder state into a parent. */
  getWheres(): WhereNode[] {
    return this.wheres;
  }

  whereIn<K extends keyof TRow & string>(column: K, values: TRow[K][] | Subquery): this {
    this.wheres.push({ type: "in", connector: "and", not: false, column, values });

    return this;
  }

  orWhereIn<K extends keyof TRow & string>(column: K, values: TRow[K][] | Subquery): this {
    this.wheres.push({ type: "in", connector: "or", not: false, column, values });

    return this;
  }

  whereNotIn<K extends keyof TRow & string>(column: K, values: TRow[K][] | Subquery): this {
    this.wheres.push({ type: "in", connector: "and", not: true, column, values });

    return this;
  }

  orWhereNotIn<K extends keyof TRow & string>(column: K, values: TRow[K][] | Subquery): this {
    this.wheres.push({ type: "in", connector: "or", not: true, column, values });

    return this;
  }

  whereNull<K extends keyof TRow & string>(column: K): this {
    this.wheres.push({ type: "null", connector: "and", not: false, column });

    return this;
  }

  orWhereNull<K extends keyof TRow & string>(column: K): this {
    this.wheres.push({ type: "null", connector: "or", not: false, column });

    return this;
  }

  whereNotNull<K extends keyof TRow & string>(column: K): this {
    this.wheres.push({ type: "null", connector: "and", not: true, column });

    return this;
  }

  orWhereNotNull<K extends keyof TRow & string>(column: K): this {
    this.wheres.push({ type: "null", connector: "or", not: true, column });

    return this;
  }

  whereBetween<K extends keyof TRow & string>(column: K, min: TRow[K], max: TRow[K]): this {
    this.wheres.push({ type: "between", connector: "and", not: false, column, min, max });

    return this;
  }

  orWhereBetween<K extends keyof TRow & string>(column: K, min: TRow[K], max: TRow[K]): this {
    this.wheres.push({ type: "between", connector: "or", not: false, column, min, max });

    return this;
  }

  whereNotBetween<K extends keyof TRow & string>(column: K, min: TRow[K], max: TRow[K]): this {
    this.wheres.push({ type: "between", connector: "and", not: true, column, min, max });

    return this;
  }

  orWhereNotBetween<K extends keyof TRow & string>(column: K, min: TRow[K], max: TRow[K]): this {
    this.wheres.push({ type: "between", connector: "or", not: true, column, min, max });

    return this;
  }

  whereColumn<K extends keyof TRow & string>(first: K, operator: WhereOperator, second: K): this {
    this.wheres.push({ type: "column", connector: "and", not: false, first, operator, second });

    return this;
  }

  orWhereColumn<K extends keyof TRow & string>(first: K, operator: WhereOperator, second: K): this {
    this.wheres.push({ type: "column", connector: "or", not: false, first, operator, second });

    return this;
  }

  /**
   * `whereColumn()` where `second` belongs to the ENCLOSING query, the
   * correlation predicate of an `EXISTS`/`IN` subquery.
   *
   * Framework-internal: `EloquentBuilder`'s existence builders use it so
   * `alias()` doesn't rewrite the outer reference along with the inner
   * ones, which is what a self-referential relation needs. App code
   * wants `whereColumn()`; see `ColumnWhereNode.secondIsOuter`.
   */
  whereOuterColumn(first: string, operator: WhereOperator, second: string): this {
    this.wheres.push({
      type: "column",
      connector: "and",
      not: false,
      first,
      operator,
      second,
      secondIsOuter: true,
    });

    return this;
  }

  whereExists(subquery: Subquery): this {
    this.wheres.push({ type: "exists", connector: "and", not: false, subquery });

    return this;
  }

  orWhereExists(subquery: Subquery): this {
    this.wheres.push({ type: "exists", connector: "or", not: false, subquery });

    return this;
  }

  whereNotExists(subquery: Subquery): this {
    this.wheres.push({ type: "exists", connector: "and", not: true, subquery });

    return this;
  }

  orWhereNotExists(subquery: Subquery): this {
    this.wheres.push({ type: "exists", connector: "or", not: true, subquery });

    return this;
  }

  /** Escape hatch for a raw SQL fragment as a where condition, anything not covered by the typed methods above. */
  whereRaw(sqlText: string, bindings: Bindable[] = []): this {
    this.wheres.push({ type: "raw", connector: "and", sqlText, bindings });

    return this;
  }

  orWhereRaw(sqlText: string, bindings: Bindable[] = []): this {
    this.wheres.push({ type: "raw", connector: "or", sqlText, bindings });

    return this;
  }

  private pushDatePart<V extends string | number | Date | DateTime>(
    connector: Connector,
    part: DatePart,
    column: string,
    args: DateWhereArgs<V>,
  ): this {
    const [operator, rawValue] = args.length === 2 ? args : (["=", args[0]] as const);
    // Formatted eagerly rather than at compile time (as `where()`'s
    // values are), because a date part is compared as an already-extracted
    // calendar *field*, `"03"`, `"2024"`, not as a timestamp, so there
    // is nothing for the dialect to spell differently.
    const value =
      rawValue instanceof DateTime
        ? formatDateTimePart(part, rawValue)
        : rawValue instanceof Date
          ? formatDatePart(part, rawValue)
          : String(rawValue);
    this.wheres.push({ type: "datePart", connector, part, column, operator, value });

    return this;
  }

  whereDate<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: string | Date | DateTime,
  ): this;
  whereDate<K extends keyof TRow & string>(column: K, value: string | Date | DateTime): this;
  whereDate(column: string, ...args: DateWhereArgs<string | Date | DateTime>): this {
    return this.pushDatePart("and", "date", column, args);
  }

  orWhereDate<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: string | Date | DateTime,
  ): this;
  orWhereDate<K extends keyof TRow & string>(column: K, value: string | Date | DateTime): this;
  orWhereDate(column: string, ...args: DateWhereArgs<string | Date | DateTime>): this {
    return this.pushDatePart("or", "date", column, args);
  }

  whereTime<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: string | Date | DateTime,
  ): this;
  whereTime<K extends keyof TRow & string>(column: K, value: string | Date | DateTime): this;
  whereTime(column: string, ...args: DateWhereArgs<string | Date | DateTime>): this {
    return this.pushDatePart("and", "time", column, args);
  }

  orWhereTime<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: string | Date | DateTime,
  ): this;
  orWhereTime<K extends keyof TRow & string>(column: K, value: string | Date | DateTime): this;
  orWhereTime(column: string, ...args: DateWhereArgs<string | Date | DateTime>): this {
    return this.pushDatePart("or", "time", column, args);
  }

  whereDay<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: string | number | Date | DateTime,
  ): this;
  whereDay<K extends keyof TRow & string>(
    column: K,
    value: string | number | Date | DateTime,
  ): this;
  whereDay(column: string, ...args: DateWhereArgs<string | number | Date | DateTime>): this {
    return this.pushDatePart("and", "day", column, args);
  }

  orWhereDay<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: string | number | Date | DateTime,
  ): this;
  orWhereDay<K extends keyof TRow & string>(
    column: K,
    value: string | number | Date | DateTime,
  ): this;
  orWhereDay(column: string, ...args: DateWhereArgs<string | number | Date | DateTime>): this {
    return this.pushDatePart("or", "day", column, args);
  }

  whereMonth<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: string | number | Date | DateTime,
  ): this;
  whereMonth<K extends keyof TRow & string>(
    column: K,
    value: string | number | Date | DateTime,
  ): this;
  whereMonth(column: string, ...args: DateWhereArgs<string | number | Date | DateTime>): this {
    return this.pushDatePart("and", "month", column, args);
  }

  orWhereMonth<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: string | number | Date | DateTime,
  ): this;
  orWhereMonth<K extends keyof TRow & string>(
    column: K,
    value: string | number | Date | DateTime,
  ): this;
  orWhereMonth(column: string, ...args: DateWhereArgs<string | number | Date | DateTime>): this {
    return this.pushDatePart("or", "month", column, args);
  }

  whereYear<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: string | number | Date | DateTime,
  ): this;
  whereYear<K extends keyof TRow & string>(
    column: K,
    value: string | number | Date | DateTime,
  ): this;
  whereYear(column: string, ...args: DateWhereArgs<string | number | Date | DateTime>): this {
    return this.pushDatePart("and", "year", column, args);
  }

  orWhereYear<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: string | number | Date | DateTime,
  ): this;
  orWhereYear<K extends keyof TRow & string>(
    column: K,
    value: string | number | Date | DateTime,
  ): this;
  orWhereYear(column: string, ...args: DateWhereArgs<string | number | Date | DateTime>): this {
    return this.pushDatePart("or", "year", column, args);
  }

  /**
   * `column` may reference a nested path with `->` (e.g. `"meta->tags"`),
   * matching Laravel's JSON-column dot-path convention. See
   * `splitJsonColumn()`. Compiles to whichever containment construct the
   * connection's engine provides (`json_each()` on SQLite,
   * `json_contains()` on MySQL, `@>` on Postgres). See
   * `query/grammar.ts`.
   */
  whereJsonContains(column: keyof TRow & string, value: Bindable): this {
    this.wheres.push({ type: "jsonContains", connector: "and", not: false, column, value });

    return this;
  }

  orWhereJsonContains(column: keyof TRow & string, value: Bindable): this {
    this.wheres.push({ type: "jsonContains", connector: "or", not: false, column, value });

    return this;
  }

  whereJsonDoesntContain(column: keyof TRow & string, value: Bindable): this {
    this.wheres.push({ type: "jsonContains", connector: "and", not: true, column, value });

    return this;
  }

  orWhereJsonDoesntContain(column: keyof TRow & string, value: Bindable): this {
    this.wheres.push({ type: "jsonContains", connector: "or", not: true, column, value });

    return this;
  }

  whereJsonContainsKey(column: keyof TRow & string): this {
    this.wheres.push({ type: "jsonContainsKey", connector: "and", not: false, column });

    return this;
  }

  orWhereJsonContainsKey(column: keyof TRow & string): this {
    this.wheres.push({ type: "jsonContainsKey", connector: "or", not: false, column });

    return this;
  }

  whereJsonDoesntContainKey(column: keyof TRow & string): this {
    this.wheres.push({ type: "jsonContainsKey", connector: "and", not: true, column });

    return this;
  }

  orWhereJsonDoesntContainKey(column: keyof TRow & string): this {
    this.wheres.push({ type: "jsonContainsKey", connector: "or", not: true, column });

    return this;
  }

  whereJsonLength<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: number,
  ): this;
  whereJsonLength<K extends keyof TRow & string>(column: K, value: number): this;
  whereJsonLength(column: string, ...args: JsonLengthArgs): this {
    const [operator, value] = args.length === 2 ? args : (["=", args[0]] as const);
    this.wheres.push({ type: "jsonLength", connector: "and", column, operator, value });

    return this;
  }

  orWhereJsonLength<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: number,
  ): this;
  orWhereJsonLength<K extends keyof TRow & string>(column: K, value: number): this;
  orWhereJsonLength(column: string, ...args: JsonLengthArgs): this {
    const [operator, value] = args.length === 2 ? args : (["=", args[0]] as const);
    this.wheres.push({ type: "jsonLength", connector: "or", column, operator, value });

    return this;
  }

  orderBy<K extends keyof TRow & string>(column: K, direction: "asc" | "desc" = "asc"): this {
    this.orders.push({ kind: "column", column, direction });

    return this;
  }

  orderByDesc<K extends keyof TRow & string>(column: K): this {
    return this.orderBy(column, "desc");
  }

  /** Orders by `column` descending, defaults to `"created_at"`, matching Laravel's `latest()`. */
  latest<K extends keyof TRow & string>(
    column: K | "created_at" = "created_at" as K | "created_at",
  ): this {
    return this.orderBy(column as K, "desc");
  }

  /** Orders by `column` ascending, defaults to `"created_at"`, matching Laravel's `oldest()`. */
  oldest<K extends keyof TRow & string>(
    column: K | "created_at" = "created_at" as K | "created_at",
  ): this {
    return this.orderBy(column as K, "asc");
  }

  /** Appends a raw `ORDER BY` fragment, escape hatch for expressions `orderBy()` can't express. */
  orderByRaw(sqlText: string, bindings: Bindable[] = []): this {
    this.orders.push({ kind: "raw", sqlText, bindings });

    return this;
  }

  /**
   * Shuffles the result rows, matches Laravel's `inRandomOrder()`.
   * Compiles to the engine's own random function (`RANDOM()` on
   * SQLite/Postgres, `RAND()` on MySQL), resolved at execution time
   * through the active `QueryGrammar`.
   */
  inRandomOrder(): this {
    this.orders.push({ kind: "random" });

    return this;
  }

  /**
   * Clears every accumulated `orderBy()`/`orderByRaw()` entry, optionally
   * replacing it with a single new `orderBy(column, direction)`, matches
   * Laravel's `reorder()`.
   */
  reorder<K extends keyof TRow & string>(column?: K, direction: "asc" | "desc" = "asc"): this {
    this.orders = [];

    if (column !== undefined) {
      this.orderBy(column, direction);
    }

    return this;
  }

  reorderDesc<K extends keyof TRow & string>(column: K): this {
    return this.reorder(column, "desc");
  }

  distinct(): this {
    this.distinctValue = true;

    return this;
  }

  /**
   * Adds one or more `GROUP BY` columns, Laravel's `groupBy(...)`.
   * Accumulates across calls (`groupBy("a").groupBy("b")` groups by both).
   * Pair with an aggregate `selectRaw()` and/or `having()` to build
   * grouped-aggregate queries beyond what `countBy()` covers.
   *
   *   const rows = await Post.query()
   *     .selectRaw<{ user_id: string; total: number }>("user_id, count(*) as total")
   *     .groupBy("user_id")
   *     .having("total", ">", 5)
   *     .get();
   */
  groupBy<K extends keyof TRow & string>(...columns: K[]): this {
    this.groups.push(...columns);

    return this;
  }

  /** Appends a raw `GROUP BY` fragment, escape hatch for grouped expressions `groupBy()` can't express. */
  groupByRaw(sqlText: string, bindings: Bindable[] = []): this {
    this.rawGroups.push({ sqlText, bindings });

    return this;
  }

  having(column: string, operator: WhereOperator, value: Bindable): this;
  having(column: string, value: Bindable): this;
  having(column: string, ...args: [WhereOperator, Bindable] | [Bindable]): this {
    const [operator, value] = args.length === 2 ? args : (["=", args[0]] as const);
    this.havings.push({
      kind: "basic",
      connector: "and",
      column,
      operator,
      value: value as Bindable,
    });

    return this;
  }

  orHaving(column: string, operator: WhereOperator, value: Bindable): this;
  orHaving(column: string, value: Bindable): this;
  orHaving(column: string, ...args: [WhereOperator, Bindable] | [Bindable]): this {
    const [operator, value] = args.length === 2 ? args : (["=", args[0]] as const);
    this.havings.push({
      kind: "basic",
      connector: "or",
      column,
      operator,
      value: value as Bindable,
    });

    return this;
  }

  /** Appends a raw `HAVING` fragment, escape hatch, same `?`-binding convention as `whereRaw()`. */
  havingRaw(sqlText: string, bindings: Bindable[] = []): this {
    this.havings.push({ kind: "raw", connector: "and", sqlText, bindings });

    return this;
  }

  orHavingRaw(sqlText: string, bindings: Bindable[] = []): this {
    this.havings.push({ kind: "raw", connector: "or", sqlText, bindings });

    return this;
  }

  /**
   * Appends a raw, aliased SQL expression to the row's column set,
   * e.g. a correlated-subquery aggregate (`comments_count`) or a `CASE`
   * expression no typed method here covers. The SQL **must** alias its
   * result (`... AS column_name`); this builder has no separate "alias"
   * argument, matching Kysely's own `sql`-tag-select convention.
   *
   * Explicit generic argument `TExtra` describes the shape the SQL adds,
   * widens the builder's row type to `TRow & TExtra` from this call
   * onward, so `.get()`/`.first()` return rows typed with the extra
   * column(s) included:
   *
   *   const posts = await Post.query()
   *     .selectRaw<{ comments_count: number }>(
   *       "(select count(*) from comments where comments.post_id = posts.id) as comments_count",
   *     )
   *     .get();
   *   posts.first()!.comments_count  // number, typed, not `any`
   *   posts.first()!.title           // still typed from PostTable
   *
   * This is the one place `TRow` is deliberately widened rather than
   * narrowed by a `where`-style filter, matches Laravel's
   * `selectRaw()`, minus the JOIN this could otherwise require (the SQL
   * itself is a correlated subquery, so the result row shape stays
   * exactly "one row per this table's row", no join-caused duplication
   * or ambiguous column names).
   *
   * Like `whereRaw()`, `?` placeholders in `sqlText` are matched
   * positionally against `bindings` and always sent as real parameters,
   * never string-interpolated.
   */
  selectRaw<TExtra extends Record<string, any>>(
    sqlText: string,
    bindings: Bindable[] = [],
  ): QueryBuilder<TRow & TExtra> {
    this.extraSelects.push({ kind: "raw", sqlText, bindings });

    return this as QueryBuilder<TRow & TExtra>;
  }

  /**
   * Projects `(select count(*) from <subquery>) as alias`, the
   * correlated-count column behind `EloquentBuilder.withCount()`.
   *
   * Takes the subquery as a live `QueryBuilder` rather than compiled
   * SQL so it can be embedded as a real Kysely expression; see
   * `CountSelectEntry` for why round-tripping through `selectRaw()`
   * cannot work across dialects.
   */
  selectCount(subquery: QueryBuilder<any>, alias: string): this {
    this.extraSelects.push({ kind: "count", subquery, alias });

    return this;
  }

  /**
   * Restricts the column set the compiled `SELECT` projects, Laravel's
   * `select()`, replacing (not appending to) any previous `select()`
   * call, same as Laravel. Omitted entirely, this builder defaults to
   * `select *` (`selectAll()`), same as a bare `DB::table(...)`.
   *
   * The primary reason to call this directly is building a subquery for
   * `whereIn()`'s `Subquery` overload. A single-column projection is
   * what makes the compiled SQL valid as an `IN (...)` operand:
   *
   *   builder.whereIn("id", (q) => q.table("post_hashtag").select("post_id").where("hashtag_id", tagId));
   *
   * The other is disambiguating a `join()`, where `*` would return
   * colliding duplicate column names. Wildcards are accepted alongside
   * named columns (`select("posts.*", "users.name as author_name")`),
   * matching Laravel. See `startSelect()` for how the two are split
   * apart for Kysely.
   */
  select(...columns: string[]): this {
    this.selectColumns = columns;

    return this;
  }

  limit(n: number): this {
    this.limitValue = n;

    return this;
  }

  /** Alias for `limit()`, matching Laravel's Query\Builder naming. */
  take(n: number): this {
    return this.limit(n);
  }

  offset(n: number): this {
    this.offsetValue = n;

    return this;
  }

  /** Alias for `offset()`, matching Laravel's Query\Builder naming. */
  skip(n: number): this {
    return this.offset(n);
  }

  /**
   * Locks the matching rows for the duration of the surrounding
   * transaction, `SELECT ... FOR UPDATE` (exclusive) or `FOR SHARE`
   * (shared), the standard read-modify-write guard against two
   * concurrent transactions both reading a balance/stock level before
   * either writes it back.
   *
   * `true` (the default) is `FOR UPDATE`, `false` is `FOR SHARE`, and a
   * string is emitted verbatim as the trailing clause, the escape
   * hatch for engine-specific modifiers this builder doesn't model
   * (`lock("for update nowait")`, `lock("for update skip locked")`),
   * matching Laravel's `lock($value)`.
   *
   * Only meaningful inside a transaction: a lock taken by an
   * autocommitted statement is released the instant it finishes.
   *
   * **A documented no-op on SQLite**, which has no row-level locking at
   * all (one writer per database file) and rejects the clause as a
   * syntax error. The intent is still recorded, so the same code runs
   * unchanged against SQLite in tests and MySQL/Postgres in production,
   * but on SQLite it provides no isolation beyond what the
   * single-writer file already gives. Matches Laravel's own
   * `SQLiteGrammar::compileLock()`, which returns an empty string
   * unconditionally.
   */
  lock(value: boolean | string = true): this {
    this.lockValue = value;

    return this;
  }

  /** `lock(true)`, `SELECT ... FOR UPDATE`. Matches Laravel's `lockForUpdate()`. See `lock()`'s docstring re: SQLite. */
  lockForUpdate(): this {
    return this.lock(true);
  }

  /** `lock(false)`, `SELECT ... FOR SHARE`. Matches Laravel's `sharedLock()`. See `lock()`'s docstring re: SQLite. */
  sharedLock(): this {
    return this.lock(false);
  }

  private compileNode(eb: ExpressionBuilder<any, any>, node: WhereNode): any {
    switch (node.type) {
      case "basic": {
        const expr = eb(this.qualify(node.column), node.operator, this.normalize(node.value));

        return node.not ? eb.not(expr as any) : expr;
      }
      case "in": {
        // An empty value list has no valid SQL form: `in ()` is a syntax
        // error on MySQL and Postgres (SQLite happens to tolerate it).
        // Laravel compiles the constant instead, `whereIn` with nothing
        // to match matches nothing, `whereNotIn` matches everything,
        // which is also the only reading that keeps a filter built from
        // a user-supplied list from 500ing when that list is empty.
        if (Array.isArray(node.values) && node.values.length === 0) {
          return node.not ? sql<boolean>`1 = 1` : sql<boolean>`0 = 1`;
        }

        const values = Array.isArray(node.values)
          ? this.normalizeList(node.values)
          : compileSubquery(this.resolveConnection, node.values);
        const expr = eb(this.qualify(node.column), "in", values);

        return node.not ? eb.not(expr as any) : expr;
      }
      case "null": {
        const expr = eb(this.qualify(node.column), "is", null);

        return node.not ? eb.not(expr as any) : expr;
      }
      case "between": {
        const expr = eb.between(
          this.qualify(node.column),
          this.normalize(node.min),
          this.normalize(node.max),
        );

        return node.not ? eb.not(expr) : expr;
      }
      case "column": {
        const second = node.secondIsOuter ? node.second : this.qualify(node.second);
        const expr = eb(this.qualify(node.first), node.operator, eb.ref(second));

        return node.not ? eb.not(expr as any) : expr;
      }
      case "exists": {
        const expr = eb.exists(compileSubquery(this.resolveConnection, node.subquery));

        return node.not ? eb.not(expr) : expr;
      }
      case "raw": {
        return buildRawSqlExpression(node.sqlText, this.normalizeList(node.bindings));
      }
      case "group": {
        const inner = this.compileList(eb, node.nested);

        return node.not ? eb.not(inner) : inner;
      }
      case "datePart": {
        const extracted = this.grammar().datePart(node.part, this.qualify(node.column));

        return eb(extracted as any, node.operator, node.value);
      }
      case "jsonContains": {
        const expr = this.grammar().jsonContains(
          splitJsonColumn(this.qualify(node.column)),
          this.normalize(node.value),
        );

        return node.not ? eb.not(expr as any) : expr;
      }
      case "jsonContainsKey": {
        const expr = this.grammar().jsonContainsKey(splitJsonColumn(this.qualify(node.column)));

        return node.not ? eb.not(expr as any) : expr;
      }
      case "jsonLength": {
        const length = this.grammar().jsonLength(splitJsonColumn(this.qualify(node.column)));

        return eb(length as any, node.operator, node.value);
      }
    }
  }

  /** Combines a list of nodes into a single expression, honoring each node's own `and`/`or` connector. */
  private compileList(eb: ExpressionBuilder<any, any>, nodes: WhereNode[]): any {
    if (nodes.length === 0) {
      return eb.and([]);
    }

    let result = this.compileNode(eb, nodes[0]!);

    for (let i = 1; i < nodes.length; i++) {
      const node = nodes[i]!;
      const expr = this.compileNode(eb, node);
      result = node.connector === "or" ? eb.or([result, expr]) : eb.and([result, expr]);
    }

    return result;
  }

  private applyWheres(qb: any): any {
    if (this.wheres.length === 0) {
      return qb;
    }

    return qb.where((eb: ExpressionBuilder<any, any>) => this.compileList(eb, this.wheres));
  }

  /**
   * Applies every accumulated `join()`/`leftJoin()`/`crossJoin()`,
   * called immediately after `startSelect()` and **before**
   * `applyWheres()` everywhere a SELECT is built, so a where clause may
   * reference a joined table's columns.
   */
  private applyJoins(qb: SelectQueryBuilder<any, any, any>): SelectQueryBuilder<any, any, any> {
    let result = qb;

    for (const join of this.joins) {
      if (join.type === "cross") {
        result = result.crossJoin(join.table as any) as any;
        continue;
      }

      const method = join.type === "left" ? "leftJoin" : "innerJoin";
      result = (result as any)[method](join.table, (j: any) =>
        j.on((eb: ExpressionBuilder<any, any>) =>
          compileJoinOns(eb, join.ons, (value) => this.normalize(value)),
        ),
      );
    }

    return result;
  }

  /** Applies every accumulated `union()`/`unionAll()` operand, called last, after ordering/limit, matching SQL's own clause order. */
  private applyUnions(qb: SelectQueryBuilder<any, any, any>): SelectQueryBuilder<any, any, any> {
    let result = qb;

    for (const node of this.unions) {
      const operand = compileSubquery(this.resolveConnection, node.subquery);
      result = node.all ? (result.unionAll(operand) as any) : (result.union(operand) as any);
    }

    return result;
  }

  private applyGroups(qb: SelectQueryBuilder<any, any, any>): SelectQueryBuilder<any, any, any> {
    let result = qb;

    for (const column of this.groups) {
      result = result.groupBy(this.qualify(column) as any);
    }

    for (const raw of this.rawGroups) {
      result = result.groupBy(
        buildRawSqlExpression(raw.sqlText, this.normalizeList(raw.bindings)) as any,
      );
    }

    return result;
  }

  private applyHavings(qb: SelectQueryBuilder<any, any, any>): SelectQueryBuilder<any, any, any> {
    if (this.havings.length === 0) {
      return qb;
    }

    return qb.having((eb: ExpressionBuilder<any, any>) => {
      const compile = (node: HavingNode): any =>
        node.kind === "basic"
          ? eb(node.column, node.operator, this.normalize(node.value))
          : buildRawSqlExpression(node.sqlText, this.normalizeList(node.bindings));
      let result = compile(this.havings[0]!);

      for (let i = 1; i < this.havings.length; i++) {
        const node = this.havings[i]!;
        const expr = compile(node);
        result = node.connector === "or" ? eb.or([result, expr]) : eb.and([result, expr]);
      }

      return result;
    });
  }

  private applyOrders(qb: SelectQueryBuilder<any, any, any>): SelectQueryBuilder<any, any, any> {
    let result = qb;

    for (const order of this.orders) {
      if (order.kind === "column") {
        result = result.orderBy(this.qualify(order.column) as any, order.direction);
      } else if (order.kind === "random") {
        result = result.orderBy(this.grammar().randomOrder() as any);
      } else {
        result = result.orderBy(
          buildRawSqlExpression(order.sqlText, this.normalizeList(order.bindings)) as any,
        );
      }
    }

    return result;
  }

  private applyOrdersLimitOffset(
    qb: SelectQueryBuilder<any, any, any>,
  ): SelectQueryBuilder<any, any, any> {
    let result = this.applyOrders(qb);

    if (this.limitValue !== undefined) {
      result = result.limit(this.limitValue);
    }

    if (this.offsetValue !== undefined) {
      result = result.offset(this.offsetValue);
    }

    return result;
  }

  private applyExtraSelects(
    qb: SelectQueryBuilder<any, any, any>,
  ): SelectQueryBuilder<any, any, any> {
    let result = qb;

    for (const extra of this.extraSelects) {
      result =
        extra.kind === "raw"
          ? result.select(
              buildRawSqlExpression(extra.sqlText, this.normalizeList(extra.bindings)) as any,
            )
          : result.select(extra.subquery.buildCountSubquery().as(extra.alias) as any);
    }

    return result;
  }

  /**
   * The bare `FROM {table} {joins}` clause every SELECT-shaped query
   * starts from, with no projection applied yet, split out from
   * `startSelect()` because Kysely requires joins to be declared
   * **before** column projection (`selectFrom(t).innerJoin(...).select(...)`),
   * and because the aggregate terminals (`count()`/`exists()`/`min()`/...)
   * need the joins too but project their own aggregate column instead.
   *
   * Throws if no table has been bound yet (a subquery callback that
   * never called `table()`), matching Kysely's own error for an empty
   * `selectFrom("")`.
   */
  private startFrom(): SelectQueryBuilder<any, any, any> {
    if (!this.tableName) {
      throw new Error(
        "QueryBuilder: no table bound — call table(name) before building a subquery.",
      );
    }

    return this.applyJoins(this.resolveConnection().selectFrom(this.getTable()) as any);
  }

  /**
   * Starts a fresh `SELECT` against this builder's table (joins applied),
   * projecting either the explicit `select()` column list (if set) or
   * every column (`selectAll()`, Laravel's default `select *`), shared
   * by `buildSelect()`/`first()`/`chunk()`/`lazy()` so all of them honor
   * an explicit `select()` call the same way.
   */
  private startSelect(): SelectQueryBuilder<any, any, any> {
    const from = this.startFrom();

    if (!this.selectColumns) {
      return from.selectAll();
    }

    // Kysely splits column projection across two methods: `select()` for
    // named columns and `selectAll()` for `*`/`table.*` wildcards (which
    // it rejects as a `select()` argument). Laravel takes both through
    // one `select()`, so the split happens here rather than at call
    // sites. `select("posts.*", "users.name as author")` is the normal
    // idiom on a joined query and has to work.
    const wildcards: string[] = [];
    const named: string[] = [];

    for (const raw of this.selectColumns) {
      const column = this.qualify(raw);

      if (column === "*") {
        wildcards.push("*");
      } else if (column.endsWith(".*")) {
        wildcards.push(column.slice(0, -2));
      } else {
        named.push(column);
      }
    }

    let qb = from;

    for (const scope of wildcards) {
      qb = scope === "*" ? qb.selectAll() : qb.selectAll(scope as any);
    }

    if (named.length > 0) {
      qb = qb.select(named as any);
    }

    return qb;
  }

  private buildSelect(): SelectQueryBuilder<any, any, any> {
    let qb: SelectQueryBuilder<any, any, any> = this.startSelect();

    if (this.distinctValue) {
      qb = qb.distinct();
    }

    qb = this.applyExtraSelects(qb);
    qb = this.applyWheres(qb);
    qb = this.applyGroups(qb);
    qb = this.applyHavings(qb);
    qb = this.applyUnions(qb);
    qb = this.applyOrdersLimitOffset(qb);
    qb = this.applyLock(qb);

    return qb;
  }

  /**
   * Appends the row-locking clause set by `lock()`/`lockForUpdate()`/
   * `sharedLock()`, on engines that have row locks.
   *
   * Skipped entirely on SQLite, where there is no row-level lock to
   * take and Kysely emits `for update` into SQL the engine then fails
   * to parse. See `lock()`'s docstring.
   *
   * A string `lock("for update nowait")` is passed through verbatim as
   * a raw clause, matching Laravel's `lock($value)` escape hatch for
   * engine-specific modifiers (`NOWAIT`, `SKIP LOCKED`) this builder
   * doesn't model.
   */
  private applyLock(qb: SelectQueryBuilder<any, any, any>): SelectQueryBuilder<any, any, any> {
    if (this.lockValue === undefined) {
      return qb;
    }

    if (!this.grammar().supportsRowLocks) {
      return qb;
    }

    if (typeof this.lockValue === "string") {
      return qb.modifyEnd(sql.raw(this.lockValue)) as any;
    }

    return this.lockValue ? (qb.forUpdate() as any) : (qb.forShare() as any);
  }

  /** The lock mode set via `lock()`/`lockForUpdate()`/`sharedLock()`, if any. See `lock()`'s docstring. */
  getLock(): boolean | string | undefined {
    return this.lockValue;
  }

  /**
   * This builder as a scalar `COUNT(*)` subquery, `(select count(*)
   * from {table} where {this builder's wheres})`, returned as a Kysely
   * expression ready to be aliased into an outer query's projection.
   *
   * Ignores `orderBy()`/`limit()`/`offset()` (same as `count()`), and
   * deliberately omits `distinct()`/`select()`/extra-selects since a
   * correlated existence/count subquery only ever needs the row count.
   *
   * Used by `EloquentBuilder.withCount()` (through `selectCount()`) to
   * add a `{relation}_count` column, the accumulated `where()`
   * conditions carry the relation's correlation (`related.fk =
   * parent.local`) plus any `whereHas`-style constraining callback the
   * caller applied.
   *
   * Joins **are** applied: a `withCount()` over a relation whose builder
   * joins a pivot table needs the join present for its correlation
   * predicate to resolve.
   *
   * Returns an expression rather than a `{ sql, bindings }` pair
   * specifically so the outer query embeds it as a subquery Kysely
   * compiles itself. Handing back a SQL string forced the caller to
   * re-parse it through `selectRaw()`'s `?`-splitting, which is wrong on
   * any engine that numbers its placeholders, on Postgres the compiled
   * fragment contains `$1` and no `?` at all, so the bindings could not
   * be reattached.
   */
  buildCountSubquery(): any {
    const base = this.startFrom().select((eb: any) => eb.fn.countAll().as("aggregate"));

    return this.applyWheres(base);
  }

  async get(): Promise<TRow[]> {
    return (await this.buildSelect().execute()) as TRow[];
  }

  /**
   * The first matching row, or `undefined`.
   *
   * Compiles with `LIMIT 1` (unless a smaller/equal explicit `limit()`
   * is already set), which Kysely's `executeTakeFirst()` does NOT add on
   * its own. It is `const [row] = await execute()`, so without this the
   * database materialises and ships the *entire* result set to discard
   * all but the first row. `find()`, `findOrFail()`, `firstOrCreate()`,
   * `refresh()` and every `belongsTo().first()` all route through here.
   *
   * `offset()` is honoured (`first()` after `skip(10)` means the 11th
   * row), which is why the limit is applied on top of `applyOrders()`
   * rather than by reusing `applyOrdersLimitOffset()`.
   */
  async first(): Promise<TRow | undefined> {
    let qb: SelectQueryBuilder<any, any, any> = this.startSelect();

    if (this.distinctValue) {
      qb = qb.distinct();
    }

    qb = this.applyExtraSelects(qb);
    qb = this.applyWheres(qb);
    qb = this.applyGroups(qb);
    qb = this.applyHavings(qb);
    qb = this.applyUnions(qb);
    qb = this.applyOrders(qb);
    // Always exactly one row, Laravel's `take(1)`. An earlier `limit()`
    // doesn't narrow this: `first()` means "the first row", and the old
    // `Math.min(limit, 1)` only ever differed for `limit(0)`, where it made
    // `first()` silently return nothing.
    qb = qb.limit(1);

    if (this.offsetValue !== undefined) {
      qb = qb.offset(this.offsetValue);
    }

    return (await qb.executeTakeFirst()) as TRow | undefined;
  }

  /**
   * True when this query's row count can't be obtained by swapping the
   * projection for `count(*)`, because the clauses that decide *how
   * many rows come back* live above the `WHERE`.
   *
   * `groupBy` collapses rows into groups (a bare `count(*)` would return
   * one row per group, and `executeTakeFirst()` would read the first
   * group's size as the total); `having` filters those groups; `distinct`
   * deduplicates the projection; a `union` appends another query's rows
   * entirely. In every case the honest count is "how many rows does the
   * finished query produce", which needs the finished query as a
   * subquery, Laravel's `getCountForPagination()` makes the same split.
   */
  private needsCountSubquery(): boolean {
    return (
      this.groups.length > 0 ||
      this.rawGroups.length > 0 ||
      this.havings.length > 0 ||
      this.unions.length > 0 ||
      this.distinctValue
    );
  }

  /**
   * Counts rows matching this builder's accumulated `where()` conditions,
   * deliberately ignores `orderBy()`/`limit()`/`offset()`, so
   * pagination's "total across all pages" is correct even though the
   * same builder chain also has a page-sized `limit`/`offset` applied
   * (mirrors Laravel's `Builder::getCountForPagination()`).
   *
   * `groupBy`/`having`/`distinct`/`union` queries are counted by wrapping
   * the whole query as a subquery (`select count(*) from (…)`). See
   * `needsCountSubquery()`.
   */
  async count(): Promise<number> {
    if (this.needsCountSubquery()) {
      return this.countViaSubquery();
    }

    const base = this.startFrom().select((eb: any) => eb.fn.countAll().as("count"));
    const qb = this.applyWheres(base);
    const row = await qb.executeTakeFirstOrThrow();

    return Number(row.count);
  }

  /**
   * `select count(*) from ({this query}) as aggregate`, the count for a
   * grouped/distinct/having/union query.
   *
   * Built through a `clone()` with the ordering and paging stripped: an
   * `ORDER BY` inside a counted subquery is pointless work and outright
   * illegal in some dialects, and a `LIMIT`/`OFFSET` would count one
   * page rather than the total (the same reason plain `count()` ignores
   * them).
   */
  private async countViaSubquery(): Promise<number> {
    const inner = this.clone();
    inner.orders = [];
    inner.limitValue = undefined;
    inner.offsetValue = undefined;

    const row: any = await this.resolveConnection()
      .selectFrom(inner.buildSelect().as("aggregate"))
      .select((eb: any) => eb.fn.countAll().as("count"))
      .executeTakeFirstOrThrow();

    return Number(row.count);
  }

  /** `true` if any row matches this builder's accumulated `where()` conditions. */
  async exists(): Promise<boolean> {
    const base = this.startFrom()
      .select((eb: any) => eb.lit(1).as("one"))
      .limit(1);
    const qb = this.applyWheres(base);
    const row = await qb.executeTakeFirst();

    return row !== undefined;
  }

  async doesntExist(): Promise<boolean> {
    return !(await this.exists());
  }

  private async aggregate(
    fn: "min" | "max" | "sum" | "avg",
    column: keyof TRow & string,
  ): Promise<number | null> {
    const base = this.startFrom().select((eb: any) => eb.fn[fn](this.qualify(column)).as("value"));
    const qb = this.applyWheres(base);
    const row = await qb.executeTakeFirstOrThrow();

    return row.value === null || row.value === undefined ? null : Number(row.value);
  }

  min(column: keyof TRow & string): Promise<number | null> {
    return this.aggregate("min", column);
  }

  max(column: keyof TRow & string): Promise<number | null> {
    return this.aggregate("max", column);
  }

  sum(column: keyof TRow & string): Promise<number | null> {
    return this.aggregate("sum", column);
  }

  avg(column: keyof TRow & string): Promise<number | null> {
    return this.aggregate("avg", column);
  }

  /**
   * `GROUP BY column` + `COUNT(*)` over this builder's accumulated
   * `where()` conditions, returned as a `column value -> count` map,
   * the in-builder replacement for hand-rolling a raw Kysely
   * `groupBy()`/`countAll()` query (Eloquent has no single-call
   * equivalent either; this is this framework's own addition, used for
   * batch counts like "likes per post" without an N+1).
   */
  async countBy<K extends keyof TRow & string>(column: K): Promise<Map<TRow[K], number>> {
    const base = this.startFrom()
      .select([this.qualify(column), (eb: any) => eb.fn.countAll().as("count")])
      .groupBy(this.qualify(column));
    const qb = this.applyWheres(base);
    const rows = await qb.execute();

    return new Map(rows.map((row: any) => [row[column], Number(row.count)]));
  }

  /**
   * Processes matching rows in offset-based pages of `size`, Laravel's
   * `chunk()`. Runs one `SELECT ... LIMIT size OFFSET n` per page until a
   * short page is returned, calling `callback` with each page's rows.
   * Return `false` from `callback` to stop early (matching Laravel).
   *
   * Honors this builder's own `where`/`orderBy` (an explicit `orderBy` is
   * strongly recommended for stable paging); ignores any pre-set
   * `limit`/`offset` (this method manages them). Immune to nothing,
   * unlike `chunkById()`, offset paging can skip/repeat rows if the
   * underlying data is mutated mid-iteration; for that use `each()` over
   * a stable ordering or fetch ids up front.
   */
  async chunk(
    size: number,
    callback: (rows: TRow[]) => void | boolean | Promise<void | boolean>,
  ): Promise<void> {
    let page = 0;

    for (;;) {
      const rows = (await this.applyOrders(
        this.applyUnions(this.applyHavings(this.applyGroups(this.applyWheres(this.startSelect())))),
      )
        .limit(size)
        .offset(page * size)
        .execute()) as TRow[];

      if (rows.length === 0) {
        return;
      }

      const result = await callback(rows);

      if (result === false) {
        return;
      }

      if (rows.length < size) {
        return;
      }

      page++;
    }
  }

  /**
   * Calls `callback` once per matching row, fetched in offset-based pages
   * of `size` behind the scenes, Laravel's `each()`. Return `false` from
   * `callback` to stop early. Built on `chunk()`.
   */
  async each(
    callback: (row: TRow, index: number) => void | boolean | Promise<void | boolean>,
    size = 1000,
  ): Promise<void> {
    let index = 0;
    await this.chunk(size, async (rows) => {
      for (const row of rows) {
        const result = await callback(row, index++);

        if (result === false) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * An async generator yielding matching rows one at a time, fetched in
   * offset-based pages of `size`, Laravel's `lazy()`, adapted to Node's
   * `for await` (a more natural fit than PHP's `Generator`).
   *
   *   for await (const row of Model.query().orderBy("id").toBase().lazy()) {
   *     process(row);
   *   }
   */
  async *lazy(size = 1000): AsyncGenerator<TRow, void, unknown> {
    let page = 0;

    for (;;) {
      const rows = (await this.applyOrders(
        this.applyUnions(this.applyHavings(this.applyGroups(this.applyWheres(this.startSelect())))),
      )
        .limit(size)
        .offset(page * size)
        .execute()) as TRow[];

      for (const row of rows) {
        yield row;
      }

      if (rows.length < size) {
        return;
      }

      page++;
    }
  }

  /**
   * Alias for `lazy()`, Laravel's `Query\Builder::cursor()`. On this
   * driver it pages rather than doing true single-row PDO streaming
   * (better-sqlite3 has no incremental cursor API through Kysely), but
   * exposes the same `for await` interface so call sites are portable if
   * a streaming driver lands later.
   */
  cursor(size = 1000): AsyncGenerator<TRow, void, unknown> {
    return this.lazy(size);
  }

  /**
   * The table name the write terminals (`insert`/`update`/`delete`/
   * `upsert`/`increment`) target. `alias()` and `join()` are SELECT-only
   * here, SQLite supports neither an aliased `UPDATE` target nor
   * `UPDATE ... JOIN`, so rather than silently dropping them (emitting a
   * statement that quietly writes the wrong rows) this throws.
   */
  private writeTable(): string {
    if (this.joins.length > 0) {
      throw new Error(
        "QueryBuilder: join() is select-only — insert()/update()/delete() cannot be run on a joined query. " +
          "Filter with whereIn(subquery)/whereExists() instead.",
      );
    }

    if (this.tableAlias !== undefined || this.tableName.includes(" as ")) {
      throw new Error(
        `QueryBuilder: alias() is select-only — insert()/update()/delete() cannot target the aliased table "${this.getTable()}".`,
      );
    }

    return this.tableName;
  }

  /**
   * Inserts a row and returns the values passed in, **not** the stored
   * row, so a DB-generated key or column default is not reflected back.
   * `Model.create()` is the path that reads a generated primary key (see
   * `insertAndReadGeneratedId()`).
   *
   * Takes `Partial<TRow>`, not `TRow`: requiring every column would make a
   * column with a database default (`created_at`, a `DEFAULT 0` flag) or a
   * generated key impossible to omit, the very columns this method
   * documents as not being read back. `Model.create()` is `Partial` for
   * the same reason.
   */
  async insert(values: Partial<TRow>): Promise<Partial<TRow>> {
    await this.resolveConnection()
      .insertInto(this.writeTable())
      .values(this.normalizeValues(values) as any)
      .execute();

    return values;
  }

  /**
   * Updates every row matching this builder's accumulated `where()`
   * conditions. Returns the number of affected rows.
   */
  async update(values: Partial<TRow>): Promise<number> {
    let qb = this.resolveConnection()
      .updateTable(this.writeTable())
      .set(this.normalizeValues(values) as any);
    qb = this.applyWheres(qb);
    const result = await qb.executeTakeFirst();

    return Number(result?.numUpdatedRows ?? 0);
  }

  /**
   * Deletes every row matching this builder's accumulated `where()`
   * conditions. Returns the number of affected rows.
   */
  async delete(): Promise<number> {
    let qb = this.resolveConnection().deleteFrom(this.writeTable());
    qb = this.applyWheres(qb);
    const result = await qb.executeTakeFirst();

    return Number(result?.numDeletedRows ?? 0);
  }

  /**
   * If a row matching `attributes` exists, updates it with `values`
   * (returns `true` even when `values` is empty and nothing was
   * written); otherwise inserts `{ ...attributes, ...values }`. Matches
   * Laravel's `Query\Builder::updateOrInsert()`.
   *
   * Every `attributes` predicate is added to a **clone**, never to
   * `this`. This method reads and then writes, so the naive form pushes
   * the same where-group onto the builder twice and, because this
   * builder mutates in place (see the class docstring), leaves both
   * behind permanently, poisoning every later use of the same chain.
   */
  async updateOrInsert(attributes: Partial<TRow>, values: Partial<TRow> = {}): Promise<boolean> {
    const matching = (): QueryBuilder<TRow> =>
      this.clone().where((q) => {
        for (const [column, value] of Object.entries(attributes)) {
          q.where(column as keyof TRow & string, value as TRow[keyof TRow & string]);
        }
      });

    if (!(await matching().exists())) {
      await this.insert({ ...attributes, ...values });

      return true;
    }

    if (Object.keys(values).length === 0) {
      return true;
    }

    return (await matching().update(values)) > 0;
  }

  /**
   * Inserts every row in `values`; for any row that conflicts with an
   * existing one on `uniqueBy` (a column or list of columns with a
   * unique index/constraint), updates the conflicting row's `update`
   * columns instead (defaults to every column in `values` when
   * omitted). Matches Laravel's `Query\Builder::upsert()`.
   *
   * The conflict clause itself is dialect-specific, `ON CONFLICT
   * (cols) DO UPDATE ... excluded.col` on SQLite/Postgres, `ON
   * DUPLICATE KEY UPDATE ... VALUES(col)` on MySQL, so it is delegated
   * to the active `QueryGrammar`. One consequence worth knowing:
   * MySQL's form has no conflict-target list, so **any** unique index
   * on the table triggers the update there, not only `uniqueBy`.
   */
  // `Partial<TRow>[]` for the same reason as `insert()`. See its docstring.
  async upsert(
    values: Partial<TRow>[],
    uniqueBy: (keyof TRow & string) | (keyof TRow & string)[],
    update?: (keyof TRow & string)[],
  ): Promise<number> {
    if (values.length === 0) {
      return 0;
    }

    const conflictColumns = Array.isArray(uniqueBy) ? uniqueBy : [uniqueBy];
    const updateColumns = update ?? (Object.keys(values[0]!) as (keyof TRow & string)[]);

    const insert = this.resolveConnection()
      .insertInto(this.writeTable())
      .values(values.map((row) => this.normalizeValues(row)) as any);
    const qb = this.grammar().applyUpsert(insert, conflictColumns, updateColumns);

    const result = await qb.executeTakeFirst();

    return Number(result?.numInsertedOrUpdatedRows ?? 0);
  }

  private async incrementEachInternal(
    columns: Partial<Record<keyof TRow & string, number>>,
    extra: Partial<TRow>,
    sign: 1 | -1,
  ): Promise<number> {
    let qb = this.resolveConnection()
      .updateTable(this.writeTable())
      .set((eb: any) => {
        const set: Record<string, any> = { ...this.normalizeValues(extra) };

        for (const [column, amount] of Object.entries(columns)) {
          set[column] = eb(column, sign === 1 ? "+" : "-", amount as number);
        }

        return set;
      });
    qb = this.applyWheres(qb);
    const result = await qb.executeTakeFirst();

    return Number(result?.numUpdatedRows ?? 0);
  }

  /** Increments `column` by `amount` (default `1`) on every row matching this builder's `where()` conditions. */
  increment(column: keyof TRow & string, amount = 1, extra: Partial<TRow> = {}): Promise<number> {
    return this.incrementEachInternal(
      { [column]: amount } as Partial<Record<keyof TRow & string, number>>,
      extra,
      1,
    );
  }

  /** Increments each column in `columns` by its given amount, in one `UPDATE`. */
  incrementEach(
    columns: Partial<Record<keyof TRow & string, number>>,
    extra: Partial<TRow> = {},
  ): Promise<number> {
    return this.incrementEachInternal(columns, extra, 1);
  }

  /** Decrements `column` by `amount` (default `1`) on every row matching this builder's `where()` conditions. */
  decrement(column: keyof TRow & string, amount = 1, extra: Partial<TRow> = {}): Promise<number> {
    return this.incrementEachInternal(
      { [column]: amount } as Partial<Record<keyof TRow & string, number>>,
      extra,
      -1,
    );
  }

  /** Decrements each column in `columns` by its given amount, in one `UPDATE`. */
  decrementEach(
    columns: Partial<Record<keyof TRow & string, number>>,
    extra: Partial<TRow> = {},
  ): Promise<number> {
    return this.incrementEachInternal(columns, extra, -1);
  }

  /**
   * Escape hatch, the underlying Kysely SELECT builder, with this
   * builder's `where`/`orderBy`/`limit`/`offset`/`distinct` already
   * applied, for anything not covered above (joins, column projection,
   * vector/full-text/JSON operators).
   */
  raw(): SelectQueryBuilder<any, any, any> {
    return this.buildSelect();
  }

  /** The compiled SELECT SQL for this builder's current state, with `?` placeholders in place of bound values, matches Laravel's `toSql()`. */
  toSql(): string {
    return this.buildSelect().compile().sql;
  }

  /**
   * The compiled SELECT SQL with every bound value substituted directly
   * into the string (for logging/debugging only, never execute this
   * string against a real connection), matches Laravel's `toRawSql()`.
   */
  toRawSql(): string {
    const compiled = this.buildSelect().compile();
    let i = 0;

    return compiled.sql.replace(/\?/g, () => {
      const value = compiled.parameters[i++];

      return typeof value === "string" ? `'${value.replace(/'/g, "''")}'` : String(value);
    });
  }

  /** The positional bound values for this builder's current SELECT state, in the same order as `toSql()`'s `?` placeholders, matches Laravel's `getBindings()`. */
  getBindings(): readonly SqlBinding[] {
    return this.buildSelect().compile().parameters as readonly SqlBinding[];
  }

  /**
   * Returns a new `QueryBuilder` with the same accumulated `where`/
   * `order`/`limit`/`offset`/`distinct`/`lock` state, mutating the
   * clone (or the original) afterwards does not affect the other.
   * Matches Laravel's `clone()`; unlike Laravel, this builder otherwise
   * mutates `this` on every chained call (see the class docstring), so
   * `clone()` is the one explicit escape hatch for branching a query into
   * two independent variations from a shared prefix:
   *
   *   const base = Model.query().where("published", 1);
   *   const featured = base.clone().where("featured", 1).get();
   *   const recent = base.orderByDesc("created_at").limit(10).get();
   */
  clone(): QueryBuilder<TRow> {
    const cloned = new QueryBuilder<TRow>(this.resolveConnection, this.tableName);
    cloned.wheres = [...this.wheres];
    cloned.orders = [...this.orders];
    cloned.groups = [...this.groups];
    cloned.rawGroups = [...this.rawGroups];
    cloned.havings = [...this.havings];
    cloned.limitValue = this.limitValue;
    cloned.offsetValue = this.offsetValue;
    cloned.distinctValue = this.distinctValue;
    cloned.lockValue = this.lockValue;
    cloned.extraSelects = [...this.extraSelects];
    cloned.selectColumns = this.selectColumns ? [...this.selectColumns] : undefined;
    cloned.joins = [...this.joins];
    cloned.unions = [...this.unions];
    cloned.tableAlias = this.tableAlias;

    return cloned;
  }

  /**
   * Conditionally apply a callback, Laravel's `Conditionable::when()`.
   * A function `value` is invoked with `this` to produce the condition.
   * The callback's return is used when it isn't `null`/`undefined`;
   * otherwise `this` is returned so a void callback still chains.
   * No `HigherOrderWhenProxy` magic form.
   */
  // The closure-condition overload is declared FIRST. Overloads resolve in
  // order, and the value overload's `TValue extends (...) => _R ? never :
  // TValue` guard resolves to `never` for a function argument, which
  // still *matches*, binding `TValue` to `never` and leaving the callback
  // parameter an implicit `any`. Putting the closure form first means
  // `when((q) => ..., (q) => ...)` infers `q` properly.
  when<TValue, TReturn = this>(
    value: (builder: this) => TValue,
    callback: (builder: this, value: TValue) => TReturn | void,
    defaultCb?: (builder: this, value: TValue) => TReturn | void,
  ): this | TReturn;
  when<TValue, TReturn = this>(
    value: TValue extends (...args: never) => infer _R ? never : TValue,
    callback: (builder: this, value: TValue) => TReturn | void,
    defaultCb?: (builder: this, value: TValue) => TReturn | void,
  ): this | TReturn;
  when<TValue, TReturn = this>(
    value: TValue | ((builder: this) => TValue),
    callback: (builder: this, value: TValue) => TReturn | void,
    defaultCb?: (builder: this, value: TValue) => TReturn | void,
  ): this | TReturn {
    return applyWhen(this, value, callback, defaultCb, false);
  }

  // Closure-condition overload first. See the note on `when()`.
  unless<TValue, TReturn = this>(
    value: (builder: this) => TValue,
    callback: (builder: this, value: TValue) => TReturn | void,
    defaultCb?: (builder: this, value: TValue) => TReturn | void,
  ): this | TReturn;
  unless<TValue, TReturn = this>(
    value: TValue extends (...args: never) => infer _R ? never : TValue,
    callback: (builder: this, value: TValue) => TReturn | void,
    defaultCb?: (builder: this, value: TValue) => TReturn | void,
  ): this | TReturn;
  unless<TValue, TReturn = this>(
    value: TValue | ((builder: this) => TValue),
    callback: (builder: this, value: TValue) => TReturn | void,
    defaultCb?: (builder: this, value: TValue) => TReturn | void,
  ): this | TReturn {
    return applyWhen(this, value, callback, defaultCb, true);
  }
}
