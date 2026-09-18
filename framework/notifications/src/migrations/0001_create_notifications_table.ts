import { Schema, type Migration, type Blueprint } from "@mahiframework/database";

/**
 * The generic, polymorphic `notifications` table backing `DatabaseChannel`,
 * a port of Laravel's `notifications` table shape.
 *
 * `type` is the `Notification` subclass name (`"InvoicePaid"`, …); `data`
 * is that notification's JSON-encoded `toDatabase()` payload;
 * `notifiable_type`/`notifiable_id` identify the recipient. The
 * discriminant is the notifiable's `morphAlias()` (or, for a plain
 * adapter class that isn't a `Model`, its static `table`), so the pair is
 * a standard morph column pair. A read-model over this table can declare
 * a `morphTo` for `notifiable` and eager-load recipients. `read_at` NULL
 * means unread. `updated_at` tracks when `read_at` last flipped (Laravel's
 * `notifications` table carries it too), so the `DatabaseNotification`
 * read-model can enable timestamps and `markAsRead()` stamps it.
 *
 * This replaces the app's former bespoke single-purpose notifications table
 * (single `user_id` FK, closed-union `type` column) with a shape reusable
 * across any notifiable model, not just `User`.
 */
const migration: Migration = {
  async up(): Promise<void> {
    await Schema.create("notifications", (table: Blueprint) => {
      table.string("id").primary();
      table.string("type");
      table.string("notifiable_type");
      table.bigInteger("notifiable_id");
      table.text("data");
      table.timestamp("read_at").nullable();
      table.timestamp("created_at");
      table.timestamp("updated_at");
      table.index(["notifiable_type", "notifiable_id"]);
    });
  },

  async down(): Promise<void> {
    await Schema.drop("notifications");
  },
};

export default migration;
