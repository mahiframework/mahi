export type ReferentialAction = "cascade" | "restrict" | "set null" | "set default" | "no action";

export type IndexKind = "index" | "unique" | "primary" | "fullText" | "spatialIndex";

export type BlueprintMode = "create" | "alter";

/**
 * The index method (`USING ...`). The four Postgres names that are
 * validated, plus `(string & {})` so `brin`, `spgist` or an
 * extension-provided method still passes through, since those are real
 * and the alternative would be lying about what is checked.
 */
export type IndexMethod = "btree" | "hash" | "gin" | "gist" | (string & {});

/**
 * Everything beyond "these columns" that an index can carry.
 *
 * Passed as the second argument to `unique()` / `index()`, in place of
 * the plain name string:
 *
 *   table.unique("torrent_id", { where: "torrent_id is not null" });
 *   table.index("criteria", { using: "gin" });
 *   table.index("title", { using: "gin", opclass: { title: "gin_trgm_ops" } });
 *
 * Not every engine can do every one of these, and the ones that cannot
 * **throw** rather than quietly creating something weaker. See
 * `assertSupportedIndexes()` in `grammars/indexes.ts` for the matrix.
 */
export interface IndexOptions {
  /** Index name. Defaults to Laravel's `{table}_{cols}_{type}`. */
  name?: string;

  /**
   * Partial index predicate, the `WHERE` of `CREATE INDEX ... WHERE ...`.
   * Postgres and SQLite; **throws on MySQL**, which has no partial
   * indexes.
   *
   * The reason this is worth having at all is that it is not only an
   * optimisation: `UNIQUE (col) WHERE col IS NOT NULL` is a correctness
   * constraint with no non-partial spelling. A plain `unique()` on a
   * nullable column permits many nulls, and "at most one non-null,
   * unlimited nulls" cannot be said any other way.
   *
   * ⚠️ Raw SQL, embedded verbatim (like `storedAs()`/`virtualAs()`).
   * **Never build this from request input.** Index predicates cannot be
   * parameterised, it is a database restriction rather than a choice
   * here, so there is no safe-binding form to fall back on.
   */
  where?: string;

  /**
   * Index method. Postgres takes any (`gin`, `gist`, `brin`, ...); MySQL
   * takes `btree`/`hash` only and throws on the rest; SQLite throws,
   * having only btree.
   */
  using?: IndexMethod;

  /**
   * Per-column operator class, keyed by column name. Postgres only;
   * throws elsewhere.
   *
   *   { using: "gin", opclass: { title: "gin_trgm_ops" } }
   *
   * ⚠️ `gin_trgm_ops` additionally needs `CREATE EXTENSION pg_trgm`,
   * which stays the application's own explicit statement: creating an
   * extension is a privileged, database-wide side effect that a table
   * blueprint should not perform implicitly.
   */
  opclass?: Record<string, string>;

  /**
   * `NULLS NOT DISTINCT`, making nulls collide like any other value.
   * Unique indexes only, and Postgres 15+ only; throws on the other
   * engines.
   *
   * The exact inverse of the `where: "col is not null"` partial-unique
   * case, and the other half of what a nullable unique column might
   * mean. Both are opt-in because they want opposite things and neither
   * is a safe default.
   */
  nullsNotDistinct?: boolean;
}

export interface IndexCommand {
  kind: IndexKind;
  columns: string[];
  name?: string;
  where?: string;
  using?: IndexMethod;
  opclass?: Record<string, string>;
  nullsNotDistinct?: boolean;
}

/**
 * Normalise the second argument of `unique()`/`index()`, which is
 * either the bare name (the original signature) or a full options
 * object.
 */
export function asIndexOptions(options?: string | IndexOptions): IndexOptions {
  if (options === undefined) {
    return {};
  }

  return typeof options === "string" ? { name: options } : options;
}

export function asColumnList(columns: string | string[]): string[] {
  return Array.isArray(columns) ? columns : [columns];
}

/** Infer `users` from `user_id` (Laravel's foreignId()->constrained() convention, naive plural). */
export function inferTableFromForeignId(column: string): string {
  const base = column.endsWith("_id") ? column.slice(0, -3) : column;

  return base.endsWith("s") ? base : `${base}s`;
}
