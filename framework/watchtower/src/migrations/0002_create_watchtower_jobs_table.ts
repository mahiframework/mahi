import { Schema, type Blueprint, type Migration } from "@mahiframework/database";

/**
 * `watchtower_jobs`, backing `WatchtowerQueueDriver`.
 *
 * A separate table from `jobs` rather than columns added to it. The
 * driver needs `dispatch_id` (stable across retries), `deferrals` (a
 * cooldown counter that must NOT be `attempts`) and `priority`, and
 * `dispatch_id` additionally requires changing what `retry()` does.
 * Adding all that to a table every existing app has already migrated
 * would be a breaking change to the core queue package in service of an
 * optional one.
 *
 * The cost is real and worth stating: a job dispatched on the `database`
 * connection is invisible to Watchtower and vice versa. Switching an app
 * over means changing the connection and draining the old queue; no
 * migration moves in-flight rows.
 *
 * There is deliberately NO `watchtower_failed_jobs`. The driver
 * implements `FailedJobRepository` against the existing `failed_jobs`
 * table, so `queue:failed`, `queue:retry`, `queue:forget` and
 * `queue:flush` keep working unchanged. A second failed-job store would
 * fork the one part of the queue CLI operators actually reach for during
 * an incident.
 *
 * ## `id` is auto-increment, and that is load-bearing
 *
 * It is the FIFO tiebreak. `available_at` has only second precision, so
 * a burst dispatched inside one second ties on it and `id` alone decides
 * the order. An auto-increment key ascends with insert order, strictly.
 *
 * A UUIDv7 would nearly work — it is time-ordered — but only to
 * millisecond granularity, and ids minted within one millisecond have no
 * guaranteed order relative to each other. A burst dispatched in a tight
 * loop lands inside one millisecond routinely, which would reintroduce
 * exactly the shuffle FIFO promises not to have. The history tables use
 * UUIDv7 because nothing orders on their keys; this one cannot.
 *
 * ## `deferrals` is not `attempts`
 *
 * A deferral is a process-wide cooldown: the job goes back to the head
 * of its queue and the whole process waits. It must not consume an
 * attempt, because the job did not fail — an upstream rate limit said
 * "not yet". Counting it would fail jobs that never failed, after a few
 * cooldowns. `deferrals` bounds the behaviour separately so a job that
 * defers forever still eventually falls back to a normal retry.
 *
 * ## `reserved_by`, not `process`
 *
 * A pending row has no owning process: which process reserves it depends
 * on the queue configuration at that moment, and several may be eligible.
 * Recording a process on insert would be a guess. `reserved_by` is the
 * worker child's run id, written when the row is actually reserved, so
 * "worker 7 died holding this" is reportable. Process attribution lives
 * on the run row, where it is known.
 *
 * ## The index
 *
 * `(queue, priority, available_at, id)` — column order is correctness,
 * not just performance. On MySQL an `ORDER BY … LIMIT 1 FOR UPDATE SKIP
 * LOCKED` that needs a filesort locks every row it sorts, so a second
 * worker skips all of them and gets nothing: three workers on a
 * three-job queue would take one job between them. The index must serve
 * the ordering directly.
 *
 * `reserved_at` is deliberately NOT in it. It appears only inside an
 * `OR` (null, or older than the retry window), which no B-tree can
 * range-scan, and leading with it forces the filesort this index exists
 * to avoid.
 *
 * `priority` is indexed ascending even though the query orders it
 * descending. `Blueprint.index()` does accept an `indexExpression()`,
 * but expressions are emitted verbatim and quoting identifiers inside
 * one is the caller's job, so a descending composite index means a
 * per-dialect quoting branch for a query that fetches a single row. The
 * ascending index still serves the range scan.
 */
const migration: Migration = {
  async up(): Promise<void> {
    await Schema.create("watchtower_jobs", (table: Blueprint) => {
      table.bigIncrements("id");

      // Stable across retries, so run history can group attempts.
      table.uuid("dispatch_id");

      table.string("queue").default("default");

      // Higher wins, within one queue. Cross-queue priority is the order
      // of a process's `queues` array instead.
      table.smallInteger("priority").default(0);

      table.string("job_class");
      table.text("payload_json");

      // Remaining chain links to dispatch after this job succeeds, NULL
      // for an unchained job.
      table.text("chain_json").nullable();

      table.integer("attempts").default(0);
      table.integer("deferrals").default(0);

      table.timestamp("available_at");
      table.timestamp("reserved_at").nullable();
      table.uuid("reserved_by").nullable();
      table.timestamp("created_at");

      table.index(["queue", "priority", "available_at", "id"]);
      table.index(["dispatch_id"]);
    });
  },

  async down(): Promise<void> {
    await Schema.drop("watchtower_jobs");
  },
};

export default migration;
