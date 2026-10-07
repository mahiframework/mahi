import { Cast, Model, belongsTo, type BelongsTo } from "@mahiframework/database";
import type { BuilderFor } from "@mahiframework/database";
import type { DateTime } from "@mahiframework/datetime";
import { WatchtowerJobType } from "./watchtower-job-type.model.js";

/**
 * Where one attempt got to.
 *
 * `released` is terminal for the row but not for the job: the attempt
 * ended by being put back on the queue, and the next attempt is its own
 * row. It is distinct from `failed` because a release is not an error —
 * a rate-limited job that will succeed in a minute should not show up in
 * a failure rate.
 */
export type JobRunStatus = "pending" | "running" | "completed" | "failed" | "released";

/** The attributes of the `watchtower_job_runs` table. */
export interface WatchtowerJobRunAttributes {
  id: string;

  watchtower_job_type_id: string;

  /**
   * The id of one logical dispatch, stable across every retry.
   *
   * NOT the queue row's key, which changes on retry: both drivers
   * re-insert rather than resurrect, so the key identifies a row and not
   * the work. This is what makes "failed three times then succeeded" one
   * story instead of four unrelated rows.
   */
  dispatch_id: string;

  /**
   * The id of THIS attempt, from `Invocation.id()`.
   *
   * The highest-value column here for debugging, because it is what
   * joins a run to the application's own log lines: every line a job
   * emits carries the same id. Per-attempt, not per-dispatch — the
   * worker opens a fresh invocation scope for each job it pops.
   *
   * Nullable because a row can be created by a `JobFailed` that arrived
   * without its `JobProcessing` (the recording queue can reorder), and
   * an absent id is better than a wrong one.
   */
  invocation_id: string | null;

  /** The supervised process that worked it, when one did. */
  process: string | null;

  /** The named queue it was reserved from. */
  queue: string | null;

  /** The worker child's run id, so a death can be attributed to one worker. */
  worker_run_id: string | null;

  status: JobRunStatus;

  /** 1-based: the first attempt is `1`, not `0`. */
  attempt: number;

  queued_at: DateTime | null;
  started_at: DateTime | null;
  finished_at: DateTime | null;

  /**
   * How long `handle()` ran, in milliseconds.
   *
   * Stored rather than derived from the timestamps because those are
   * second-precision on every engine, which would round a 200ms job to
   * zero and make p50/p95 meaningless for exactly the fast jobs that
   * dominate a queue.
   */
  duration_ms: number | null;

  /**
   * The failure, `error.stack ?? error.message`.
   *
   * UNTRUSTED. A job can throw an error whose message embeds user input,
   * so this reaches the dashboard as attacker-controlled text and must
   * be escaped at every render. See `DefaultDashboardTheme`.
   */
  error: string | null;

  type: BelongsTo<WatchtowerJobType>;
}

/**
 * One attempt at one job.
 *
 * Written three times per job on the happy path (running → completed),
 * by `RecordJobRunListener` rather than by the driver, so the history
 * works on ANY queue driver and not only this package's.
 *
 * `keyType: "uuidv7"` for the same reasons as `WatchtowerJobType`: a
 * client-assigned key skips the `RETURNING` round-trip, which matters
 * more here because the writes are frequent and come from several worker
 * processes at once.
 *
 * `timestamps: false`: the three timestamps here are domain events with
 * their own meaning, and a `created_at` would duplicate `queued_at`
 * while an `updated_at` would record when the recorder ran rather than
 * when anything happened.
 *
 * Rows are pruned on `finished_at`, which is why it is indexed. The
 * table grows by one row per job per attempt, so pruning is mandatory
 * maintenance rather than housekeeping.
 */
export class WatchtowerJobRun extends Model<WatchtowerJobRunAttributes>()({
  table: "watchtower_job_runs",
  primaryKey: "id",
  keyType: "uuidv7",
  morphName: "WatchtowerJobRun",
  timestamps: false,
  casts: {
    attempt: Cast.integer(),
    duration_ms: Cast.integer(),
    queued_at: Cast.datetime(),
    started_at: Cast.datetime(),
    finished_at: Cast.datetime(),
  },
}) {
  static override relationships = {
    type: belongsTo(() => WatchtowerJobType, {
      foreignKey: "watchtower_job_type_id",
    }),
  };

  /**
   * Every attempt at one dispatch, oldest first.
   *
   * Ordered by `attempt` rather than a timestamp because two attempts
   * can share a second-precision `started_at`, and the attempt number is
   * the thing that actually sequences them.
   */
  static forDispatch(dispatchId: string): BuilderFor<WatchtowerJobRunAttributes, WatchtowerJobRun> {
    return this.query().where("dispatch_id", dispatchId).orderBy("attempt", "asc");
  }

  /** The row for one specific attempt, which is the upsert target. */
  static forAttempt(
    dispatchId: string,
    attempt: number,
  ): BuilderFor<WatchtowerJobRunAttributes, WatchtowerJobRun> {
    return this.query().where("dispatch_id", dispatchId).where("attempt", attempt);
  }

  /** Failures since `since`, newest first. */
  static failedSince(since: DateTime): BuilderFor<WatchtowerJobRunAttributes, WatchtowerJobRun> {
    return this.query()
      .where("status", "failed")
      .where("finished_at", ">=", since)
      .orderBy("finished_at", "desc");
  }

  /** Runs of one job type since `since`, newest first. */
  static forTypeSince(
    typeId: string,
    since: DateTime,
  ): BuilderFor<WatchtowerJobRunAttributes, WatchtowerJobRun> {
    return this.query()
      .where("watchtower_job_type_id", typeId)
      .where("started_at", ">=", since)
      .orderBy("started_at", "desc");
  }
}
