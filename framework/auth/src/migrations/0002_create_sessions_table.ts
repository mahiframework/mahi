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
 */
const migration: Migration = {
  async up(): Promise<void> {
    await Schema.create("sessions", (table: Blueprint) => {
      table.string("id").primary();
      table.bigInteger("user_id").index();
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
