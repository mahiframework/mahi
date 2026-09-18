import { Schema, type Migration, type Blueprint } from "@mahiframework/database";

/**
 * `sessions` backing `DatabaseSessionStore`.
 *
 * Only the session id lives in the (signed) cookie; everything else stays
 * here, which is what makes a session revocable by deleting its row.
 *
 * `expires_at` is indexed for `gc()`, `user_id` for "log this user out
 * everywhere". No foreign key to `users`. That table is app-owned and
 * the framework can't assume its name.
 *
 * `user_id` is text on purpose, even though an app keying `User` by a
 * snowflake or an auto-increment stores a 64-bit number in it. The key
 * type is the app's choice — `keyType: "uuid"` is equally supported —
 * and a `bigInteger` column would make Postgres reject a UUID outright
 * rather than simply not match. Text holds every key type losslessly,
 * and this column is only ever looked up by equality.
 */
const migration: Migration = {
  async up(): Promise<void> {
    await Schema.create("sessions", (table: Blueprint) => {
      table.string("id").primary();
      table.string("user_id").index();
      table.timestamp("expires_at").index();
      table.timestamp("created_at");
      table.timestamp("last_active_at");
    });
  },

  async down(): Promise<void> {
    await Schema.drop("sessions");
  },
};

export default migration;
