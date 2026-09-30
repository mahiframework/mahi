import { sql, type Kysely } from "kysely";
import type { Blueprint } from "../blueprint.js";
import type { ColumnDefinition } from "../column-definition.js";
import type { ForeignKeyDefinition } from "../foreign-key-definition.js";
import type { SchemaGrammar } from "../dialect.js";
import {
  introspectTable,
  type IntrospectedColumn,
  type IntrospectedForeignKey,
} from "../introspect.js";
import { compileColumnType } from "./column-types.js";
import {
  assertSupportedIndexes,
  collectIndexes,
  createIndex,
  namedForeign,
  namedPrimary,
  namedUnique,
  type IndexCapabilities,
} from "./indexes.js";

/**
 * What SQLite's indexes can do.
 *
 * `fullText` is FTS5, a virtual table rather than an index on an
 * existing one, so it is not the same concept `fullText()` names.
 */
const SQLITE_INDEX_CAPS: IndexCapabilities = {
  dialect: "sqlite",
  supportsFullText: false,
};

function normalizeDefault(value: unknown): unknown {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  return value;
}

function applyColumnModifiers(
  col: any,
  def: ColumnDefinition,
  options?: { skipPrimary?: boolean },
): any {
  const skipPrimary = options?.skipPrimary ?? false;

  if (!skipPrimary) {
    if (def.autoIncrementFlag) {
      col = col.primaryKey().autoIncrement();
    } else if (def.primaryFlag) {
      col = col.primaryKey();
    }
  }

  if (!def.nullableFlag) {
    col = col.notNull();
  }

  if (def.useCurrentFlag) {
    col = col.defaultTo(sql`CURRENT_TIMESTAMP`);
  } else if (def.hasDefault) {
    col = col.defaultTo(normalizeDefault(def.defaultValue));
  }

  if (def.storedAsExpr) {
    col = col.generatedAlwaysAs(sql.raw(def.storedAsExpr));
    col = typeof col.stored === "function" ? col.stored() : col.modifyEnd(sql`stored`);
  } else if (def.virtualAsExpr) {
    col = col.generatedAlwaysAs(sql.raw(def.virtualAsExpr));
  }

  return col;
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

async function compileCreate(db: Kysely<any>, blueprint: Blueprint): Promise<void> {
  assertSupportedIndexes(blueprint.indexes, SQLITE_INDEX_CAPS);
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
    builder = builder.addColumn(col.name, compileColumnType(col, "sqlite"), (c: any) =>
      applyColumnModifiers(c, col, { skipPrimary: skipColumnPrimary }),
    );
  }

  for (const pk of compositePrimary) {
    builder = builder.addPrimaryKeyConstraint(namedPrimary(table, pk.columns, pk.name), pk.columns);
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

  const fromCol = blueprint.columns.find((c) => c.autoIncrementFrom !== undefined);

  if (fromCol?.autoIncrementFrom !== undefined) {
    await sql`INSERT INTO sqlite_sequence (name, seq) VALUES (${table}, ${fromCol.autoIncrementFrom - 1})`.execute(
      db,
    );
  }
}

async function compileAlter(db: Kysely<any>, blueprint: Blueprint): Promise<void> {
  assertSupportedIndexes(blueprint.indexes, SQLITE_INDEX_CAPS);
  const table = blueprint.table;

  const addedForeignKeys = collectForeignKeys(blueprint);

  if (blueprint.dropForeigns.length > 0) {
    throw new Error(
      "Dropping foreign keys via Schema.table() is not supported on SQLite (requires a table rebuild).",
    );
  }

  if (blueprint.dropPrimaries.length > 0) {
    throw new Error("Dropping primary keys via Schema.table() is not supported on SQLite.");
  }

  if (blueprint.indexes.some((idx) => idx.kind === "primary")) {
    throw new Error("Adding a primary key via Schema.table() is not supported on SQLite.");
  }

  const added = blueprint.columns.filter((c) => !c.changing);
  const changed = blueprint.columns.filter((c) => c.changing);

  for (const col of added) {
    if (col.primaryFlag || col.autoIncrementFlag) {
      throw new Error("Adding a primary key column via Schema.table() is not supported on SQLite.");
    }

    await db.schema
      .alterTable(table)
      .addColumn(col.name, compileColumnType(col, "sqlite"), (c: any) =>
        applyColumnModifiers(c, col, { skipPrimary: true }),
      )
      .execute();
  }

  // SQLite cannot attach a constraint to a live table, so a new foreign key
  // means the same rebuild a changed column does: create, copy, drop, rename,
  // replaying everything introspected plus whatever is being added.
  if (changed.length > 0 || addedForeignKeys.length > 0) {
    await rebuildTable(db, table, changed, addedForeignKeys);
  }

  for (const { from, to } of blueprint.renameColumns) {
    await db.schema.alterTable(table).renameColumn(from, to).execute();
  }

  // Indexes come off BEFORE the columns they cover. See the same
  // ordering in native-alter-grammar. SQLite is the strict one here: it
  // validates surviving indexes when rebuilding the table for a
  // DROP COLUMN, and refuses outright with "error in index ... after drop
  // column: no such column".
  for (const name of blueprint.droppedIndexes) {
    await db.schema.dropIndex(name).execute();
  }

  for (const col of blueprint.droppedColumns) {
    await db.schema.alterTable(table).dropColumn(col).execute();
  }

  for (const idx of collectIndexes(blueprint, added)) {
    await createIndex(db, table, idx);
  }

  if (blueprint.renameTo) {
    await db.schema.alterTable(table).renameTo(blueprint.renameTo).execute();
  }
}

async function rebuildTable(
  db: Kysely<any>,
  table: string,
  changed: ColumnDefinition[],
  addedForeignKeys: ForeignKeyDefinition[] = [],
): Promise<void> {
  const snapshot = await introspectTable(db, table);
  const byName = new Map(changed.map((c) => [c.name, c]));

  for (const def of changed) {
    if (!snapshot.columns.some((c) => c.name === def.name)) {
      throw new Error(`Cannot change column "${def.name}" on "${table}": column does not exist.`);
    }
  }

  const tempName = `__temp__${table}`;
  const pkColumns = snapshot.columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
  const compositePk = pkColumns.length > 1;

  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    let builder: any = db.schema.createTable(tempName);

    for (const existing of snapshot.columns) {
      const def = byName.get(existing.name);

      if (def) {
        builder = builder.addColumn(def.name, compileColumnType(def, "sqlite"), (c: any) =>
          applyColumnModifiers(c, def, { skipPrimary: compositePk }),
        );
      } else {
        builder = builder.addColumn(existing.name, sql.raw(existing.type), (c: any) =>
          applyIntrospectedColumn(c, existing, compositePk),
        );
      }
    }

    if (compositePk) {
      const names = pkColumns.map((c) => c.name);
      builder = builder.addPrimaryKeyConstraint(namedPrimary(table, names), names);
    }

    for (const idx of snapshot.indexes) {
      if (idx.origin !== "u") {
        continue;
      }

      if (idx.columns.some((c) => byName.has(c))) {
        continue;
      }

      builder = builder.addUniqueConstraint(idx.name, idx.columns);
    }

    for (const def of changed) {
      if (def.uniqueIndex) {
        builder = builder.addUniqueConstraint(namedUnique(table, [def.name], def.uniqueIndex), [
          def.name,
        ]);
      }
    }

    const fksById = new Map<number, IntrospectedForeignKey[]>();

    for (const fk of snapshot.foreignKeys) {
      const group = fksById.get(fk.id) ?? [];
      group.push(fk);
      fksById.set(fk.id, group);
    }

    for (const [id, group] of fksById) {
      const first = group[0];

      if (!first) {
        continue;
      }

      builder = builder.addForeignKeyConstraint(
        `${table}_fk_${id}`,
        group.map((g) => g.from),
        first.table,
        group.map((g) => g.to),
        (cb: any) => {
          const onDelete = first.onDelete.toLowerCase();
          const onUpdate = first.onUpdate.toLowerCase();

          if (onDelete && onDelete !== "no action") {
            cb = cb.onDelete(onDelete);
          }

          if (onUpdate && onUpdate !== "no action") {
            cb = cb.onUpdate(onUpdate);
          }

          return cb;
        },
      );
    }

    // Foreign keys being ADDED by this alter, after the ones already on the
    // table. Named by the same convention `Schema.create()` uses, so a
    // constraint added later is indistinguishable from one declared up front.
    for (const fk of addedForeignKeys) {
      if (!fk.referencedTable) {
        throw new Error(
          `Foreign key on "${table}" (${fk.columns.join(", ")}) has no referenced table — call .references(...).on(...).`,
        );
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

    const colRefs = snapshot.columns.map((c) => sql.ref(c.name));
    await sql`INSERT INTO ${sql.table(tempName)} (${sql.join(colRefs)}) SELECT ${sql.join(colRefs)} FROM ${sql.table(table)}`.execute(
      db,
    );

    await db.schema.dropTable(table).execute();
    await db.schema.alterTable(tempName).renameTo(table).execute();

    for (const idx of snapshot.indexes) {
      if (idx.origin === "c" && idx.sql) {
        await sql.raw(idx.sql).execute(db);
      }
    }
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}

function applyIntrospectedColumn(
  col: any,
  existing: IntrospectedColumn,
  compositePk: boolean,
): any {
  if (!compositePk && existing.pk === 1) {
    col = col.primaryKey();

    if (existing.autoIncrement) {
      col = col.autoIncrement();
    }
  }

  if (existing.notNull) {
    col = col.notNull();
  }

  if (existing.defaultValue != null) {
    col = col.defaultTo(sql.raw(existing.defaultValue));
  }

  return col;
}

/**
 * Drop every user table. SQLite internal tables (`sqlite_*`) are left
 * alone. Foreign keys are disabled for the duration so tables can be
 * dropped in any order.
 */
async function dropAllTables(db: Kysely<any>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    const tables = await db.introspection.getTables();

    for (const table of tables) {
      if (table.isView || table.name.startsWith("sqlite_")) {
        continue;
      }

      await db.schema.dropTable(table.name).ifExists().execute();
    }
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}

export const sqliteGrammar: SchemaGrammar = {
  dialect: "sqlite",
  compileCreate,
  compileAlter,
  dropAllTables,
};
