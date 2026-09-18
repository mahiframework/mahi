import { Schema, type Migration, type Blueprint } from "@mahiframework/database";

/**
 * The original `jobs`/`failed_jobs` tables backing `DatabaseQueueDriver`.
 *
 * Kept as-is because its name is recorded in the `migrations` table of
 * every app that has ever run it; the columns and indexes the driver
 * actually relies on today are added by `0002_queue_reliability` (named
 * queues, the `pop()` index, failed-job chain/connection/queue). Read
 * that one for the current shape.
 *
 * `reserved_at` is the reservation marker: a row is eligible for `pop()`
 * when it is due and either unreserved or reserved longer ago than the
 * connection's `retryAfter`, and reserving it is a single conditional
 * UPDATE so two racing workers produce exactly one winner. See
 * `DatabaseQueueDriver.pop()`.
 */
const migration: Migration = {
  async up(): Promise<void> {
    await Schema.create("jobs", (table: Blueprint) => {
      table.bigInteger("id").primary();
      table.string("job_class");
      table.text("payload_json");
      table.integer("attempts").default(0);
      table.timestamp("available_at");
      table.timestamp("reserved_at").nullable();
      table.timestamp("created_at");
      // Remaining chain links (JSON array of { jobClass, payload }) to
      // dispatch after this job succeeds, NULL for an unchained job.
      table.text("chain_json").nullable();
    });

    await Schema.create("failed_jobs", (table: Blueprint) => {
      table.bigInteger("id").primary();
      table.string("job_class");
      table.text("payload_json");
      table.text("error");
      table.timestamp("failed_at");
    });
  },

  async down(): Promise<void> {
    await Schema.drop("failed_jobs");
    await Schema.drop("jobs");
  },
};

export default migration;
