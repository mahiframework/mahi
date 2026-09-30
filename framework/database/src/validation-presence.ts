import { app } from "@mahiframework/core";
import { Rule, type PresenceResolver } from "@mahiframework/validation";
import { DATABASE_TOKEN } from "./database-service-provider.js";
import type { DatabaseManager } from "./database-manager.js";
import { getActiveTransaction } from "./transaction-context.js";

/**
 * Register `exists` / `unique` against the default database connection.
 * Lives here so jobs/CLI can use those rules without spinning up HTTP.
 */
export function registerValidationPresenceResolver(): void {
  const resolver: PresenceResolver = {
    async exists(table, column, value) {
      const row = await kysely()
        .selectFrom(table as any)
        .select(column as any)
        .where(column as any, "=", value)
        .limit(1)
        .executeTakeFirst();

      return row !== undefined;
    },
    async unique(table, column, value, ignore) {
      let query = kysely()
        .selectFrom(table as any)
        .select(column as any)
        .where(column as any, "=", value);

      if (ignore !== undefined && ignore.id !== undefined && ignore.id !== null) {
        query = query.where(ignore.column as any, "!=", ignore.id);
      }

      const row = await query.limit(1).executeTakeFirst();

      return row === undefined;
    },
  };

  Rule.setPresenceResolver(resolver);
}

/**
 * The connection these rules query: the active transaction when one is
 * open, else the root.
 *
 * Resolved per call, never captured, the same rule
 * `Model.resolveConnection()` and `SchemaBuilder` follow. Without it a
 * `unique` check inside a transaction would read pre-transaction state
 * and pass against a row the same transaction had just written.
 */
function kysely() {
  const connection = app().make<DatabaseManager>(DATABASE_TOKEN).connection().kysely;

  return getActiveTransaction(connection) ?? connection;
}
