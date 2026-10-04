import { Schema, type Migration, type Blueprint } from "@mahiframework/database";

/**
 * One table for every kind of activity, discriminated by `type`.
 *
 * `resource` rows record a CRUD event against a tracked model; `security`
 * rows record an authentication event against a user; anything else is an
 * application-defined type written through `Activity.log()`. One table
 * rather than three because the read query is the same shape in all three
 * cases ("what happened to this thing, newest first") and splitting them
 * would make a cross-cutting audit view a union.
 *
 * `model_id` and `user_id` are TEXT, not the owner's key type. The
 * reasoning is the one `0001_create_notifications_table` records for
 * `notifiable_id`: these hold the key of *any* model, and two models in
 * one app can key differently (a UUID `User`, a snowflake `Team`). Only
 * text holds both. An activity log is strictly more polymorphic than a
 * notification, so it applies with more force.
 *
 * `model_type` is NOT nullable, and there is deliberately no subjectless
 * row. A nullable subject would make every read branch, and the case it
 * would serve, "something happened, to nothing", is a log line rather
 * than an activity record. A security event with no obvious subject is
 * recorded against the actor.
 *
 * `data` is TEXT rather than `json`/`jsonb`, matching the notifications
 * table. `JsonCast` serialises to a string regardless, and `jsonb` would
 * buy Postgres-side containment queries at the cost of engine divergence
 * in a table whose whole point is to be written cheaply and read rarely.
 * Nothing in this package queries inside `data`, so an app that wants
 * `jsonb` can alter the column without breaking anything.
 *
 * `created_at` only. An activity row is immutable: there is no operation
 * that edits one, so an `updated_at` would never move.
 *
 * NO FOREIGN KEYS. `users` is app-owned and the framework cannot assume
 * its name (the rationale `0002_create_sessions_table` records), and a
 * polymorphic `model_type`/`model_id` pair cannot have one at all.
 *
 * There is deliberately no `ip_address` or `user_agent` column. Both live
 * in `data.context` when an app wants them, seeded from `Context` by this
 * package's own pipe. Promoting them would add two mostly-null columns to
 * the highest-volume table in the application, and `request.ip()` is
 * `undefined` under in-process dispatch anyway.
 */
const migration: Migration = {
  async up(): Promise<void> {
    await Schema.create("activity_logs", (table: Blueprint) => {
      table.string("id").primary();

      // Narrow: a small, closed-ish vocabulary and the leading column of
      // an index, so it pays to keep the key short.
      table.string("type", 32);
      table.string("action").nullable();

      table.string("model_type");
      table.string("model_id");

      table.string("user_id").nullable();

      table.string("message").nullable();
      table.text("data").nullable();

      table.timestamp("created_at");

      // "The history of this record", the query a resource log exists to
      // answer. The equality pair leads so `created_at` can serve the
      // ORDER BY from the same index.
      table.index(["model_type", "model_id", "created_at"]);
      // "What has this user done", the audit query.
      table.index(["user_id", "created_at"]);
      // "Every failed login in the last hour", the security query. `type`
      // leads because it is the lower-cardinality discriminant and
      // `action` is null on a large fraction of rows.
      table.index(["type", "action", "created_at"]);
    });
  },

  async down(): Promise<void> {
    await Schema.drop("activity_logs");
  },
};

export default migration;
