import { sql, type Kysely } from "kysely";
import type { Blueprint } from "../blueprint.js";
import type { ColumnDefinition } from "../column-definition.js";
import type { ForeignKeyDefinition } from "../foreign-key-definition.js";
import type { Dialect } from "../dialect.js";
import { quoteDoubleQuoted } from "../quote-identifier.js";
import { compileColumnType } from "./column-types.js";
import {
  assertSupportedIndexes,
  collectIndexes,
  createIndex,
  namedForeign,
  namedPrimary,
  type IndexCapabilities,
} from "./indexes.js";

/**
 * Shared compiler for engines that support real, in-place `ALTER TABLE`
 * (MySQL and PostgreSQL), i.e. everything SQLite has to fake with a table
 * rebuild. The two dialects differ only in a handful of spellings
 * (auto-increment, `MODIFY`/`ALTER COLUMN`, drop-index syntax), captured by
 * the `NativeAlterOptions` hooks; the create/alter/index/foreign-key
 * plumbing is identical and lives here.
 */
export interface NativeAlterOptions extends IndexCapabilities {
  dialect: Dialect;

  /** Apply the auto-increment modifier to a Kysely column builder. */
  autoIncrement(col: any): any;

  /**
   * Drop an index by name. MySQL needs the owning table (`ALTER TABLE t
   * DROP INDEX i`); Postgres drops indexes globally (`DROP INDEX i`).
   */
  dropIndex(db: Kysely<any>, table: string, name: string): Promise<void>;

  /** Change an existing column's type/modifiers in place. */
  changeColumn(db: Kysely<any>, table: string, def: ColumnDefinition): Promise<void>;

  /** Drop a (named or implicit) primary key constraint. */
  dropPrimary(db: Kysely<any>, table: string, name?: string): Promise<void>;

  /** Drop a named foreign key constraint. */
  dropForeign(db: Kysely<any>, table: string, name: string): Promise<void>;
}

function normalizeDefault(value: unknown, dialect: Dialect): unknown {
  // MySQL stores booleans as tinyint(1); Postgres has a real boolean type
  // and rejects an integer default on it, so only coerce for MySQL.
  if (typeof value === "boolean" && dialect === "mysql") {
    return value ? 1 : 0;
  }

  return value;
}

/**
 * Restricts an `enum` column to its declared values with a `CHECK`.
 *
 * MySQL has a native `enum(...)` type that enforces this itself, and
 * SQLite is typeless. Postgres has neither: `postgresType()` compiles
 * an enum to a plain `varchar` (a native PG enum would mean owning a
 * `CREATE TYPE` and its migration lifecycle), which on its own accepts
 * *any* string, so a column declared `enum("status", ["draft",
 * "live"])` silently allowed `"banana"`. The CHECK restores the
 * constraint the declaration promises.
 */
function applyEnumCheck(col: any, def: ColumnDefinition, opts: NativeAlterOptions): any {
  if (opts.dialect !== "postgres" || def.laravelType !== "enum") {
    return col;
  }

  const allowed = def.allowed ?? [];

  if (allowed.length === 0) {
    return col;
  }

  const values = allowed.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");

  return col.check(sql.raw(`${quoteDoubleQuoted(def.name)} in (${values})`));
}

function applyColumnModifiers(
  col: any,
  def: ColumnDefinition,
  opts: NativeAlterOptions,
  options?: { skipPrimary?: boolean },
): any {
  const skipPrimary = options?.skipPrimary ?? false;

  if (!skipPrimary) {
    if (def.autoIncrementFlag) {
      col = opts.autoIncrement(col.primaryKey());
    } else if (def.primaryFlag) {
      col = col.primaryKey();
    }
  } else if (def.autoIncrementFlag) {
    col = opts.autoIncrement(col);
  }

  if (!def.nullableFlag) {
    col = col.notNull();
  }

  if (def.useCurrentFlag) {
    col = col.defaultTo(sql`CURRENT_TIMESTAMP`);
  } else if (def.hasDefault) {
    col = col.defaultTo(normalizeDefault(def.defaultValue, opts.dialect));
  }

  if (def.storedAsExpr) {
    col = col.generatedAlwaysAs(sql.raw(def.storedAsExpr)).stored();
  } else if (def.virtualAsExpr) {
    col = col.generatedAlwaysAs(sql.raw(def.virtualAsExpr));
  }

  return applyEnumCheck(col, def, opts);
}

function collectForeignKeys(blueprint: Blueprint): ForeignKeyDefinition[] {
  const fks = [...blueprint.foreignKeys];

  for (const col of blueprint.columns) {
    if (col.foreignKey) {
      fks.push(col.foreignKey);
    }
  }

  return fks;
}

export function makeNativeAlterGrammar(opts: NativeAlterOptions) {
  async function compileCreate(db: Kysely<any>, blueprint: Blueprint): Promise<void> {
    assertSupportedIndexes(blueprint.indexes, opts);
    const table = blueprint.table;

    if (blueprint.columns.some((c) => c.changing)) {
      throw new Error(
        `Column.change() is only valid inside Schema.table(), not Schema.create(), for "${table}".`,
      );
    }

    let builder: any = db.schema.createTable(table);

    const compositePrimary = blueprint.indexes.filter((i) => i.kind === "primary");
    const skipColumnPrimary = compositePrimary.length > 0;

    for (const col of blueprint.columns) {
      builder = builder.addColumn(col.name, compileColumnType(col, opts.dialect), (c: any) =>
        applyColumnModifiers(c, col, opts, { skipPrimary: skipColumnPrimary }),
      );
    }

    for (const pk of compositePrimary) {
      builder = builder.addPrimaryKeyConstraint(
        namedPrimary(table, pk.columns, pk.name),
        pk.columns,
      );
    }

    for (const fk of collectForeignKeys(blueprint)) {
      if (!fk.referencedTable) {
        throw new Error(`Foreign key on ${table}(${fk.columns.join(", ")}) is missing .on(table).`);
      }

      builder = builder.addForeignKeyConstraint(
        namedForeign(table, fk.columns, fk.constraintName),
        fk.columns,
        fk.referencedTable,
        fk.referencedColumns,
        (cb: any) => {
          if (fk.onDeleteAction) {
            cb = cb.onDelete(fk.onDeleteAction);
          }

          if (fk.onUpdateAction) {
            cb = cb.onUpdate(fk.onUpdateAction);
          }

          return cb;
        },
      );
    }

    await builder.execute();

    for (const idx of collectIndexes(blueprint, blueprint.columns)) {
      await createIndex(db, table, idx);
    }
  }

  async function compileAlter(db: Kysely<any>, blueprint: Blueprint): Promise<void> {
    assertSupportedIndexes(blueprint.indexes, opts);
    const table = blueprint.table;

    const added = blueprint.columns.filter((c) => !c.changing);
    const changed = blueprint.columns.filter((c) => c.changing);

    for (const col of added) {
      await db.schema
        .alterTable(table)
        .addColumn(col.name, compileColumnType(col, opts.dialect), (c: any) =>
          applyColumnModifiers(c, col, opts),
        )
        .execute();
    }

    for (const def of changed) {
      await opts.changeColumn(db, table, def);
    }

    for (const { from, to } of blueprint.renameColumns) {
      await db.schema.alterTable(table).renameColumn(from, to).execute();
    }

    // Indexes come off BEFORE the columns they cover. A `down()` written
    // as the mirror of its `up()` drops both in one call, and an index
    // outliving its column is either an error (SQLite refuses to rebuild
    // the table) or a dangling object. The reverse ordering cannot be
    // needed: nothing here creates an index on a column being dropped in
    // the same call, since `collectIndexes()` runs against the added ones.
    for (const name of blueprint.droppedIndexes) {
      await opts.dropIndex(db, table, name);
    }

    for (const col of blueprint.droppedColumns) {
      await db.schema.alterTable(table).dropColumn(col).execute();
    }

    // Primary key added via alter (composite).
    for (const idx of blueprint.indexes) {
      if (idx.kind === "primary") {
        await db.schema
          .alterTable(table)
          .addPrimaryKeyConstraint(namedPrimary(table, idx.columns, idx.name), idx.columns as any)
          .execute();
      }
    }

    for (const idx of collectIndexes(blueprint, added)) {
      await createIndex(db, table, idx);
    }

    for (const fk of collectForeignKeys(blueprint)) {
      if (!fk.referencedTable) {
        throw new Error(
          `Foreign key on "${table}" (${fk.columns.join(", ")}) has no referenced table — call .references(...).on(...).`,
        );
      }

      await db.schema
        .alterTable(table)
        .addForeignKeyConstraint(
          namedForeign(table, fk.columns, fk.constraintName),
          fk.columns as any,
          fk.referencedTable,
          fk.referencedColumns,
          (cb: any) => {
            if (fk.onDeleteAction) {
              cb = cb.onDelete(fk.onDeleteAction);
            }

            if (fk.onUpdateAction) {
              cb = cb.onUpdate(fk.onUpdateAction);
            }

            return cb;
          },
        )
        .execute();
    }

    for (const name of blueprint.dropForeigns) {
      await opts.dropForeign(db, table, name);
    }

    for (const dp of blueprint.dropPrimaries) {
      await opts.dropPrimary(db, table, dp.name);
    }

    if (blueprint.renameTo) {
      await db.schema.alterTable(table).renameTo(blueprint.renameTo).execute();
    }
  }

  return { compileCreate, compileAlter };
}
