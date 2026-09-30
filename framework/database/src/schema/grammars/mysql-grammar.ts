import { sql, type Kysely } from "kysely";
import type { ColumnDefinition } from "../column-definition.js";
import type { SchemaGrammar } from "../dialect.js";
import { compileColumnType } from "./column-types.js";
import { makeNativeAlterGrammar } from "./native-alter-grammar.js";
import { quoteBacktick } from "../quote-identifier.js";

const { compileCreate, compileAlter } = makeNativeAlterGrammar({
  dialect: "mysql",

  autoIncrement(col) {
    return col.autoIncrement();
  },

  async dropIndex(db, table, name) {
    // MySQL indexes are scoped to their table.
    await db.schema.alterTable(table).dropIndex(name).execute();
  },

  async dropPrimary(db, table) {
    await sql.raw(`ALTER TABLE ${quoteBacktick(table)} DROP PRIMARY KEY`).execute(db);
  },

  async dropForeign(db, table, name) {
    // `DROP FOREIGN KEY` rather than the standard `DROP CONSTRAINT`:
    // MySQL only learned the latter in 8.0.19, and MariaDB does not
    // support it for foreign keys at all, while this spelling works on
    // every version of both.
    await sql
      .raw(`ALTER TABLE ${quoteBacktick(table)} DROP FOREIGN KEY ${quoteBacktick(name)}`)
      .execute(db);
  },

  async changeColumn(db, table, def: ColumnDefinition) {
    // MySQL's MODIFY replaces the whole definition in one shot.
    await db.schema
      .alterTable(table)
      .modifyColumn(def.name, compileColumnType(def, "mysql"), (c: any) => {
        if (!def.nullableFlag) {
          c = c.notNull();
        }

        if (def.useCurrentFlag) {
          c = c.defaultTo(sql`CURRENT_TIMESTAMP`);
        } else if (def.hasDefault) {
          c = c.defaultTo(
            typeof def.defaultValue === "boolean" ? (def.defaultValue ? 1 : 0) : def.defaultValue,
          );
        }

        return c;
      })
      .execute();
  },

  // MySQL is the only engine here with `FULLTEXT`, and the only one
  // without partial indexes — there is no `CREATE INDEX ... WHERE`, and
  // no expression that substitutes for one. `USING` exists but takes
  // only `btree`/`hash`, which `assertSupportedIndexes()` enforces;
  // operator classes and `NULLS NOT DISTINCT` are Postgres-only.
  supportsFullText: true,
  supportsPartialIndexes: false,
  supportsIndexMethods: true,
  supportsOperatorClasses: false,
  supportsNullsNotDistinct: false,
});

/**
 * Drop every user (base) table. `FOREIGN_KEY_CHECKS` is disabled for the
 * duration so tables can go in any order regardless of FK dependencies.
 *
 * Runs inside `db.connection()` because `FOREIGN_KEY_CHECKS` is a
 * **session** variable: issued straight against the pool it applies to
 * whichever connection happened to serve that statement, while the
 * `DROP`s that follow may be handed different ones, leaving FK
 * enforcement on for them and failing on the first table another
 * references. It only worked before because a single idle connection
 * was being reused. Pinning one connection makes the whole sequence
 * share the session the variable was set on.
 *
 * Not a transaction: `DROP TABLE` is DDL and implicitly commits on
 * MySQL, so wrapping it would buy nothing.
 */
async function dropAllTables(db: Kysely<any>): Promise<void> {
  await db.connection().execute(async (connection) => {
    await sql`SET FOREIGN_KEY_CHECKS = 0`.execute(connection);
    try {
      const tables = await connection.introspection.getTables();

      for (const table of tables) {
        if (table.isView) {
          continue;
        }

        await connection.schema.dropTable(table.name).ifExists().execute();
      }
    } finally {
      await sql`SET FOREIGN_KEY_CHECKS = 1`.execute(connection);
    }
  });
}

export const mysqlGrammar: SchemaGrammar = {
  dialect: "mysql",
  compileCreate,
  compileAlter,
  dropAllTables,
};
