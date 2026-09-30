import { sql, type Kysely } from "kysely";
import type { ColumnDefinition } from "../column-definition.js";
import type { SchemaGrammar } from "../dialect.js";
import { isFrameworkTable } from "../framework-tables.js";
import { compileColumnType } from "./column-types.js";
import { makeNativeAlterGrammar } from "./native-alter-grammar.js";
import { quoteDoubleQuoted } from "../quote-identifier.js";

const { compileCreate, compileAlter } = makeNativeAlterGrammar({
  dialect: "postgres",

  autoIncrement(col) {
    // Postgres uses serial/bigserial pseudo-types (resolved by
    // compileColumnType), no separate modifier. The column is still the
    // primary key, which the caller applies via primaryKey().
    return col;
  },

  async dropIndex(db, _table, name) {
    // Postgres indexes live in the schema namespace, not under the table.
    await db.schema.dropIndex(name).ifExists().execute();
  },

  async dropPrimary(db, table, name) {
    const constraint = name ?? `${table}_pkey`;
    await db.schema.alterTable(table).dropConstraint(constraint).execute();
  },

  async dropForeign(db, table, name) {
    // Postgres models a foreign key as an ordinary named constraint.
    await db.schema.alterTable(table).dropConstraint(name).execute();
  },

  async changeColumn(db, table, def: ColumnDefinition) {
    // Postgres alterations are one-per-statement; issue each independently.
    await db.schema
      .alterTable(table)
      .alterColumn(def.name, (ac: any) => ac.setDataType(compileColumnType(def, "postgres")))
      .execute();

    await db.schema
      .alterTable(table)
      .alterColumn(def.name, (ac: any) => (def.nullableFlag ? ac.dropNotNull() : ac.setNotNull()))
      .execute();

    if (def.useCurrentFlag) {
      await db.schema
        .alterTable(table)
        .alterColumn(def.name, (ac: any) => ac.setDefault(sql`CURRENT_TIMESTAMP`))
        .execute();
    } else if (def.hasDefault) {
      await db.schema
        .alterTable(table)
        .alterColumn(def.name, (ac: any) =>
          ac.setDefault(
            typeof def.defaultValue === "boolean" ? def.defaultValue : def.defaultValue,
          ),
        )
        .execute();
    }
  },

  // Every optional index feature except `fullText`, which is MySQL's own
  // index type with its own query syntax. Postgres full-text is an
  // ordinary GIN index over a `to_tsvector(...)` expression, so it is
  // reached through `index([indexExpression(...)], { using: "gin" })`
  // rather than by this flag. See `Blueprint.fullText()`.
  //
  // `supportsNullsNotDistinct` is true for the grammar, but the clause
  // itself needs Postgres 15+; on 14 and older the server raises its own
  // syntax error rather than this layer version-detecting.
  supportsFullText: false,
  supportsPartialIndexes: true,
  supportsIndexMethods: true,
  supportsOperatorClasses: true,
  supportsNullsNotDistinct: true,
});

/**
 * Drop every user (base) table in the **current schema**. `CASCADE`
 * clears any dependent foreign keys so drop order doesn't matter.
 *
 * The `search_path` filter is required: Kysely's
 * `introspection.getTables()` returns every non-system table in the
 * database, across all schemas. Dropping that list unqualified would
 * reach into schemas the connection was never pointed at, so a
 * `migrate:fresh` against an app's own schema could destroy a
 * neighbouring one sharing the database. Restricting to
 * `current_schema()` (which `PostgresDriver` sets from `searchPath`)
 * confines it to the schema this connection actually works in, and the
 * drop is qualified with that schema so it cannot resolve elsewhere.
 */
async function dropAllTables(db: Kysely<any>): Promise<void> {
  const { rows } = await sql<{ schema: string }>`select current_schema() as schema`.execute(db);
  const current = rows[0]?.schema ?? "public";

  const tables = await db.introspection.getTables();

  for (const table of tables) {
    if (table.isView) {
      continue;
    }

    if (table.schema !== undefined && table.schema !== current) {
      continue;
    }

    await sql
      .raw(
        `DROP TABLE IF EXISTS ${quoteDoubleQuoted(current)}.${quoteDoubleQuoted(table.name)} CASCADE`,
      )
      .execute(db);
  }
}

/**
 * Empty every user table in the **current schema**, keeping the schema
 * itself and restarting every identity sequence.
 *
 * One `TRUNCATE a, b, c` rather than a statement per table: tables
 * truncated together in a single statement satisfy each other's foreign
 * keys, so the dependency ordering that would otherwise be needed (and
 * that nothing here can derive — Kysely's introspection reports no
 * constraint metadata) stops mattering.
 *
 * `RESTART IDENTITY` resets the `serial`/`bigserial` sequences behind
 * `increments()`/`id()` columns, which `TRUNCATE` leaves alone by
 * default.
 *
 * `CASCADE` covers a foreign key from a table *outside* the list, a
 * view's dependent, or one in another schema. That reach is why the
 * `current_schema()` filter below is not optional — see
 * `dropAllTables()` for the same hazard stated at length.
 */
async function truncateAllTables(db: Kysely<any>): Promise<void> {
  const { rows } = await sql<{ schema: string }>`select current_schema() as schema`.execute(db);
  const current = rows[0]?.schema ?? "public";

  const tables = await db.introspection.getTables();

  const targets = tables
    .filter((table) => !table.isView)
    .filter((table) => table.schema === undefined || table.schema === current)
    .filter((table) => !isFrameworkTable(table.name))
    .map((table) => `${quoteDoubleQuoted(current)}.${quoteDoubleQuoted(table.name)}`);

  // `TRUNCATE` with no tables is a syntax error, and an empty schema is
  // a legitimate state (nothing migrated yet).
  if (targets.length === 0) {
    return;
  }

  await sql.raw(`TRUNCATE TABLE ${targets.join(", ")} RESTART IDENTITY CASCADE`).execute(db);
}

export const postgresGrammar: SchemaGrammar = {
  dialect: "postgres",
  compileCreate,
  compileAlter,
  dropAllTables,
  truncateAllTables,
};
