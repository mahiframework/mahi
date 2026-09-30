import { Facade } from "@mahiframework/facades";
import type { Blueprint } from "./blueprint.js";
import type { SchemaBuilder } from "./schema-builder.js";
import { SCHEMA_TOKEN } from "../database-service-provider.js";

/**
 * Thin facade over the `SchemaBuilder` bound at `SCHEMA_TOKEN`, so
 * migrations can write `Schema.create(...)` with no connection argument.
 *
 *   await Schema.create("users", (table) => {
 *     table.id();
 *     table.timestamps();
 *   });
 *
 * Prefer constructing `SchemaBuilder` (or `DatabaseManager.schema()`)
 * where a connection is already in hand, use this at migration
 * call sites, same guidance as `app()` itself.
 */
export class Schema extends Facade<SchemaBuilder>(() => SCHEMA_TOKEN) {
  static create(table: string, callback: (blueprint: Blueprint) => void): Promise<void> {
    return this.instance().create(table, callback);
  }

  static table(table: string, callback: (blueprint: Blueprint) => void): Promise<void> {
    return this.instance().table(table, callback);
  }

  static drop(table: string): Promise<void> {
    return this.instance().drop(table);
  }

  static dropIfExists(table: string): Promise<void> {
    return this.instance().dropIfExists(table);
  }

  static rename(from: string, to: string): Promise<void> {
    return this.instance().rename(from, to);
  }

  static hasTable(table: string): Promise<boolean> {
    return this.instance().hasTable(table);
  }

  static hasColumn(table: string, column: string): Promise<boolean> {
    return this.instance().hasColumn(table, column);
  }

  static dropAllTables(): Promise<void> {
    return this.instance().dropAllTables();
  }

  static truncateAllTables(): Promise<void> {
    return this.instance().truncateAllTables();
  }
}
