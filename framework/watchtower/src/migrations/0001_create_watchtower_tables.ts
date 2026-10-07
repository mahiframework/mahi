import { Schema, type Blueprint, type Migration } from "@mahiframework/database";

/**
 * `watchtower_job_types` and `watchtower_job_runs`, the run history.
 *
 * Separate from the queue table (`0002`) because they are independently
 * useful: an app on the plain `database` queue connection can register
 * this package's listeners, run this migration alone, and get the whole
 * history without adopting the supervisor or the driver. The aggregation
 * is the more valuable half and should not be coupled to the rest.
 *
 * ## Keys are UUIDv7
 *
 * Both tables are append-heavy, written concurrently from several worker
 * processes, and never ordered on by key. A client-assigned key means an
 * insert needs no `RETURNING` round-trip, which matters because a run
 * row is written up to three times per job. v7 rather than v4 so
 * `ORDER BY id` is still roughly chronological and consecutive inserts
 * keep index locality instead of scattering.
 *
 * Note the deliberate asymmetry with `watchtower_jobs`, which uses
 * auto-increment: there the key is the FIFO tiebreak and needs strict
 * monotonicity, which a millisecond-granular UUID cannot promise. See
 * `0002`.
 *
 * ## `dispatch_id` is not the run's key
 *
 * It identifies one logical dispatch and is REPEATED across every
 * attempt at it, which is the whole point: `(dispatch_id, attempt)` is
 * unique and `dispatch_id` alone groups a retry chain. The queue row's
 * own key cannot serve this, because retrying a failed job inserts a new
 * row and deletes the old one, so that key identifies a row rather than
 * the work.
 *
 * ## `invocation_id` is per-attempt
 *
 * It is `Invocation.id()`, the id every log line from that attempt
 * carries, so this column is what joins a run to the application's logs.
 * Indexed for exactly that lookup. Nullable because the recording queue
 * can deliver a `JobFailed` whose `JobProcessing` has not arrived, and
 * an absent id beats a wrong one.
 *
 * ## No foreign key to anything app-owned
 *
 * `watchtower_job_type_id` cascades (both tables are this package's), but
 * nothing here references a user or the job's subject. The same stance
 * `activity_logs` and `notifications` take: the framework cannot assume
 * the name or key type of an app's tables.
 *
 * ## Indexes
 *
 * - `(dispatch_id, attempt)` unique — the upsert target. The recorder
 *   writes the same row two or three times as a job progresses, and the
 *   recording queue can deliver those out of order, so every write is an
 *   upsert on this pair rather than an insert.
 * - `(watchtower_job_type_id, started_at)` — "what has this job type
 *   been doing", which is the detail view and the p50/p95 aggregation.
 * - `(invocation_id)` — "show me the run for this log line".
 * - `(status, started_at)` — "what is running now" and "what failed
 *   recently", the two overview queries.
 * - `(finished_at)` — the prune query. A separate index because pruning
 *   filters on it alone and would otherwise scan the table it is trying
 *   to keep small.
 *
 * `error` is `text`, not a native JSON type, matching `activity_logs.data`
 * and `failed_jobs.error`: it is a stack trace, read whole and never
 * queried into.
 */
const migration: Migration = {
  async up(): Promise<void> {
    await Schema.create("watchtower_job_types", (table: Blueprint) => {
      table.uuid("id").primary();

      // The registry key (`app.jobs.sync-invoice`), which is what a queue
      // payload carries and what survives renaming the class.
      table.string("name");

      // The constructor name, for display. Nullable: a job whose class
      // cannot be resolved still earns a type row, because "this keeps
      // failing and nothing can run it" is worth seeing.
      table.string("class_name").nullable();

      table.timestamp("first_seen_at");
      table.timestamp("last_seen_at");

      table.unique(["name"]);
    });

    await Schema.create("watchtower_job_runs", (table: Blueprint) => {
      table.uuid("id").primary();
      table.uuid("watchtower_job_type_id");

      // `string`, not `uuid`. It usually IS a UUIDv7 — that is what this
      // package's driver assigns — but the history also records jobs from
      // drivers that have no such column, where the id is derived from
      // the queue row instead. A native Postgres `uuid` column would
      // reject those outright, and only on Postgres, which is the worst
      // place to find out.
      table.string("dispatch_id");
      table.uuid("invocation_id").nullable();

      table.string("process").nullable();
      table.string("queue").nullable();
      table.uuid("worker_run_id").nullable();

      // Narrow: a closed vocabulary of five values and the leading
      // column of an index, so a short key is worth having.
      table.string("status", 16);
      table.integer("attempt");

      table.timestamp("queued_at").nullable();
      table.timestamp("started_at").nullable();
      table.timestamp("finished_at").nullable();

      // Milliseconds, stored rather than derived: the timestamps are
      // second-precision on every engine, which would round a 200ms job
      // to zero and make a duration percentile meaningless for the fast
      // jobs that dominate a queue.
      table.integer("duration_ms").nullable();

      table.text("error").nullable();

      table.unique(["dispatch_id", "attempt"]);
      table.index(["watchtower_job_type_id", "started_at"]);
      table.index(["invocation_id"]);
      table.index(["status", "started_at"]);
      table.index(["finished_at"]);

      table
        .foreign("watchtower_job_type_id")
        .references("id")
        .on("watchtower_job_types")
        .cascadeOnDelete();
    });
  },

  async down(): Promise<void> {
    await Schema.drop("watchtower_job_runs");
    await Schema.drop("watchtower_job_types");
  },
};

export default migration;
