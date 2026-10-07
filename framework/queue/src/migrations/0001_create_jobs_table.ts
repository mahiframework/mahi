import { Schema, type Migration, type Blueprint } from "@mahiframework/database";

/**
 * The `jobs`/`failed_jobs` tables backing `DatabaseQueueDriver`.
 *
 * The columns and indexes the driver additionally relies on (named
 * queues, the `pop()` index, failed-job chain/connection/queue) are added
 * by `0002_queue_reliability`; read that one alongside this.
 *
 * `jobs.id` is auto-increment, which is what makes `ORDER BY
 * available_at, id` FIFO within a one-second `available_at` bucket:
 * `available_at` has only second precision, so a burst dispatched inside
 * one ties on it and `id` alone decides the order. See
 * `DatabaseQueueDriver.pop()`.
 *
 * `failed_jobs.id` is NOT auto-increment: a failed row carries over the
 * id of the `jobs` row it came from, so `queue:retry <id>` names the
 * same job the operator saw in `queue:failed`.
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
      table.bigIncrements("id");
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
