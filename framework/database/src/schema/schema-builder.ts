import { type Kysely } from "kysely";
import { Blueprint } from "./blueprint.js";
import type { Dialect } from "./dialect.js";
import { grammarFor } from "./grammars/index.js";
import { getActiveTransaction } from "../transaction-context.js";

/**
 * Compiles Laravel-shaped `Blueprint` callbacks into Kysely schema
 * statements for one connection. The `Schema` facade is the static
 * proxy over this class. See `schema-facade.ts`.
 *
 * `dialect` selects the grammar (SQLite/MySQL/Postgres) used to spell the
 * DDL; it defaults to `"sqlite"` so existing call sites that construct a
 * `SchemaBuilder` from a bare Kysely instance keep working.
 *
 * The connection is resolved at **statement** time, not construction
 * time, and joins an enclosing `transaction()` on it, the same rule
 * `QueryBuilder` follows. That's what lets the migrator wrap a migration
 * in a transaction and have the `Schema.create(...)` calls inside it
 * actually participate: the migration reaches the builder through the
 * `Schema` facade, which resolves a long-lived `SchemaBuilder` from the
 * container, so a connection captured at construction would have run the
 * DDL outside the transaction entirely.
 */
export class SchemaBuilder {
  constructor(
    private connection: Kysely<any>,
    private dialect: Dialect = "sqlite",
  ) {}

  /** The connection this statement runs on, the active transaction on it, if any. */
  private get db(): Kysely<any> {
    return getActiveTransaction(this.connection) ?? this.connection;
  }

  async create(table: string, callback: (blueprint: Blueprint) => void): Promise<void> {
    const blueprint = new Blueprint(table, "create");
    callback(blueprint);
    await blueprint.execute(this.db, this.dialect);
  }

  async table(table: string, callback: (blueprint: Blueprint) => void): Promise<void> {
    const blueprint = new Blueprint(table, "alter");
    callback(blueprint);
    await blueprint.execute(this.db, this.dialect);
  }

  async drop(table: string): Promise<void> {
    await this.db.schema.dropTable(table).execute();
  }

  async dropIfExists(table: string): Promise<void> {
    await this.db.schema.dropTable(table).ifExists().execute();
  }

  async rename(from: string, to: string): Promise<void> {
    await this.db.schema.alterTable(from).renameTo(to).execute();
  }

  async hasTable(table: string): Promise<boolean> {
    const tables = await this.db.introspection.getTables();

    return tables.some((t) => t.name === table);
  }

  async hasColumn(table: string, column: string): Promise<boolean> {
    const tables = await this.db.introspection.getTables();
    const match = tables.find((t) => t.name === table);

    return match?.columns.some((c) => c.name === column) ?? false;
  }

  /**
   * Drop every user table. Used by `migrate:fresh`. Delegates to the
   * dialect's grammar, which knows how to suspend FK enforcement (PRAGMA on
   * SQLite, `FOREIGN_KEY_CHECKS` on MySQL, `CASCADE` on Postgres) and which
   * internal tables to skip.
   */
  async dropAllTables(): Promise<void> {
    await grammarFor(this.dialect).dropAllTables(this.db);
  }

  /**
   * Delete every row from every user table, leaving the schema in place
   * and restarting auto-increment counters at 1. The cheap between-tests
   * reset behind `@mahiframework/testing`'s `clearDatabase()`, and far
   * cheaper than `dropAllTables()` plus a re-migrate.
   *
   * The framework's own `migrations`/`migrations_lock` ledger is
   * preserved — the schema survives, so the record of how it got there
   * has to as well.
   *
   * Delegates to the dialect's grammar, which knows how to clear tables
   * without a foreign-key dependency order (no engine here reports one)
   * and how to reset identity, which each spells differently.
   */
  async truncateAllTables(): Promise<void> {
    await grammarFor(this.dialect).truncateAllTables(this.db);
  }
}
