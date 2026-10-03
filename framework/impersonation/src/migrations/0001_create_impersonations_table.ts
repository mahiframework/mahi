import { Schema, type Migration, type Blueprint } from "@mahiframework/database";

/**
 * `impersonations`, one row per live impersonation link.
 *
 * `session_id` is unique: a session is at most one impersonation, and the
 * constraint is what makes "start an impersonation twice on one session"
 * a database error rather than a silently duplicated chain.
 *
 * `impersonator_id` and `impersonated_id` are text on purpose, and carry
 * no foreign key, for the same reasons `sessions.user_id` does: `users`
 * is app-owned so the framework can't assume its name, and the key type
 * is the app's choice. A `bigInteger` column would make Postgres reject a
 * UUID outright rather than simply not match. Text holds every key type
 * losslessly and these columns are only ever looked up by equality.
 *
 * `parent_id` self-references for nested impersonation, also without a
 * foreign key: it is maintained within one transaction by code that owns
 * both rows, and a self-referential FK would complicate nothing but the
 * teardown.
 *
 * `depth` is denormalised so the max-depth check is one read rather than
 * a chain walk. `expires_at` is indexed for `gc()`.
 */
const migration: Migration = {
  async up(): Promise<void> {
    await Schema.create("impersonations", (table: Blueprint) => {
      table.string("id").primary();
      table.string("session_id").unique();
      table.string("impersonator_id").index();
      table.string("impersonated_id").index();
      table.string("parent_id").nullable();
      table.integer("depth");
      table.boolean("remembered");
      table.timestamp("created_at");
      table.timestamp("expires_at").index();
    });
  },

  async down(): Promise<void> {
    await Schema.drop("impersonations");
  },
};

export default migration;
