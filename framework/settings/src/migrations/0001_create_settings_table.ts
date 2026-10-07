import { Schema, type Blueprint, type Migration } from "@mahiframework/database";

/**
 * `settings`, holding one row per setting whose value differs from the
 * default its definition declares.
 *
 * `key` is the primary key: a setting has at most one row, so re-setting
 * it overwrites rather than accumulating, and reading one is a single
 * indexed lookup. The same shape as `password_reset_tokens`.
 *
 * That choice is load-bearing, not incidental. The obvious alternative —
 * a `(key, user_id)` unique index with `user_id` nullable for globals —
 * cannot be made portable: `nullsNotDistinct` is Postgres 15+ only and
 * *throws* on SQLite and MySQL, so two engines out of three would permit
 * unlimited duplicate rows for the same global setting. Per-user
 * overrides, if they are ever wanted, belong in a second table with a
 * composite `(key, user_id)` primary key, where both columns are NOT
 * NULL and the guarantee holds everywhere. Documented, not built.
 *
 * `value` is `text` holding JSON, not a typed column. One column has to
 * hold a string, a number, a boolean, a date and an arbitrary object,
 * and only text does. The JSON envelope is what makes `false`, `0`, `""`
 * and `null` survive as themselves rather than becoming
 * indistinguishable from an absent row — see `value-codec.ts`. `text`
 * rather than `json`/`jsonb` matches `activity_logs.data` and
 * `notifications.data`: the value is serialised either way, and the
 * native types would buy Postgres-side containment queries in a table
 * that is only ever read whole.
 *
 * `edited_by_user_id` is nullable TEXT with NO foreign key. Nullable
 * because a write from a seeder, a CLI command or a queue worker has no
 * actor, and that is a null rather than an error. TEXT because an app's
 * user may key on an int or a UUID, and only text holds both
 * three (the rationale `0001_create_notifications_table` records for
 * `notifiable_id`). No foreign key because `users` is app-owned and the
 * framework cannot assume its name, the same reason the sessions and
 * tokens tables have none.
 *
 * No index beyond the primary key. The table holds one row per
 * customised setting — tens, not thousands — and the registry reads all
 * of it in one query to populate a cache. An index on
 * `edited_by_user_id` would serve a "what did this admin change" query
 * that belongs in `activity_logs`, which already indexes for it.
 */
const migration: Migration = {
  async up(): Promise<void> {
    await Schema.create("settings", (table: Blueprint) => {
      table.string("key").primary();
      table.text("value");
      table.string("edited_by_user_id").nullable();
      table.timestamp("created_at");
      table.timestamp("updated_at");
    });
  },

  async down(): Promise<void> {
    await Schema.drop("settings");
  },
};

export default migration;
