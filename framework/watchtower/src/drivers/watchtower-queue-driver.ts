import { randomUUIDv7 } from "node:crypto";
import type { Kysely } from "kysely";
import {
  afterCommitOn,
  dialectOf,
  getActiveTransaction,
  transaction,
} from "@mahiframework/database";
import type { Dialect } from "@mahiframework/database";
import type {
  ChainedJob,
  FailedJobRecord,
  FailedJobRepository,
  JobState,
  PushOptions,
  QueueDriver,
  QueuedJob,
} from "@mahiframework/queue";

interface JobRow {
  id: bigint;
  dispatch_id: string;
  queue: string;
  priority: number;
  job_class: string;
  payload_json: string;
  chain_json: string | null;
  attempts: number;
  deferrals: number;
  available_at: string;
  reserved_at: string | null;
  reserved_by: string | null;
  created_at: string;
}

interface FailedJobRow {
  id: bigint;
  dispatch_id: string;
  connection: string | null;
  queue: string | null;
  priority: number;
  job_class: string;
  payload_json: string;
  chain_json: string | null;
  error: string;
  failed_at: string;
}

/**
 * A job as this driver returns it, carrying the two fields the core
 * `QueuedJob` has no place for.
 *
 * Structural rather than a subclass so a plain `QueuedJob` consumer (the
 * core worker, a test fake) is unaffected, and so a caller that does care
 * can narrow with `isWatchtowerJob()`.
 */
export interface WatchtowerQueuedJob extends QueuedJob {
  /** Stable across retries; groups a job's attempts in the run history. */
  dispatchId: string;
  /**
   * How many times this job has paused its process on a `fifo` release.
   *
   * Alongside `attempts`, not instead of it: a release spends an attempt
   * either way. This counts cooldowns for reporting and for
   * `maxDeferrals`.
   */
  deferrals: number;
}

export function isWatchtowerJob(job: QueuedJob): job is WatchtowerQueuedJob {
  return typeof (job as WatchtowerQueuedJob).dispatchId === "string";
}

/**
 * A driver whose `release()` can hold the process rather than the job.
 *
 * There is no extra method and no extra argument — `fifo` is a property
 * of the *driver instance*, set from the process's config, so a job
 * always writes the same `release(this, 60)` and the configuration
 * decides what that means. See `WatchtowerQueueDriver.release()`.
 *
 * The interface exists only so a worker can check, with
 * `supportsDeferral()`, that a `fifo: true` process is not running
 * against a driver that would silently ignore it.
 */
export interface DeferrableQueueDriver {
  /** Whether this instance converts a release into a process cooldown. */
  readonly fifo: boolean;
}

/**
 * Narrowing guard, whether a resolved driver understands `fifo`.
 *
 * Takes `unknown` rather than `QueueDriver`, matching
 * `supportsFailedJobs()`: `fifo` is not on the core interface at all, so
 * a `QueueDriver`-typed parameter would need a cast at the one place the
 * check happens — which is exactly where a cast is least welcome.
 */
export function supportsDeferral(driver: unknown): driver is DeferrableQueueDriver {
  return (
    typeof driver === "object" &&
    driver !== null &&
    typeof (driver as DeferrableQueueDriver).fifo === "boolean"
  );
}

export interface WatchtowerQueueDriverOptions {
  /** The default queue this driver reads and writes. Default `"default"`. */
  queue?: string;
  /**
   * Seconds after which a reserved job is presumed abandoned and becomes
   * eligible again. **The crash-recovery mechanism**: a worker killed
   * with `-9` mid-job leaves `reserved_at` set and nothing else would
   * clear it, so without this the job is stranded — not failed, not
   * listed, simply gone.
   *
   * Must exceed the longest a job can legitimately take, INCLUDING its
   * own `timeout()`. A job's timeout is cooperative (a `Promise.race`
   * that leaves the original promise running), so reclaiming too early
   * runs the job twice concurrently.
   */
  retryAfterSeconds?: number;
  /** Candidate rows one `pop()` reads before giving up. SQLite only. Default 10. */
  popBatchSize?: number;
  dialect?: Dialect;
  /** Recorded on failed rows, so `queue:retry` knows where a job came from. */
  connectionName?: string;
  /**
   * Convert a release into a process cooldown rather than a reschedule.
   * Off by default.
   *
   * Set from the process's `fifo` config by the worker that builds the
   * driver, which is the whole point: a job calls `release(this, 60)` and
   * this flag decides whether that means "retry me in 60s, run others
   * meanwhile" or "pause the process 60s and retry me first". The job's
   * code is identical either way and runs correctly under both.
   */
  fifo?: boolean;
  /**
   * Called when a `fifo` release holds the process, to record the
   * cooldown somewhere every worker in that process can see it.
   *
   * Injected rather than resolved here because the cooldown lives in the
   * cache, and a queue driver has no business reaching for a cache
   * manager. The worker supplies it; omitted, the release still happens
   * correctly and simply holds nothing back — the right degradation for
   * a test or a single-worker script.
   */
  onDefer?: (seconds: number) => Promise<void>;
}

/**
 * The `watchtower_jobs` driver.
 *
 * A sibling of `DatabaseQueueDriver` and deliberately so: the two
 * reservation strategies, the reclaim-burns-an-attempt rule, the atomic
 * fail, the per-call connection resolution and the dialect-aware
 * timestamp are all the same hard-won behaviour, and diverging from them
 * would be a bug rather than a design.
 *
 * What is new:
 *
 * - **`fifo`**, which changes what `release()` means for this instance.
 * - **`dispatch_id`**, assigned at push and carried through release,
 *   fail and retry, so run history can group attempts.
 * - **`priority`**, ordered within a queue. Cross-queue priority is the
 *   order of a process's `queues` list instead.
 */
export class WatchtowerQueueDriver
  implements QueueDriver, FailedJobRepository, DeferrableQueueDriver
{
  /**
   * Whether a release holds the process instead of rescheduling the job.
   *
   * Public and readonly so `supportsDeferral()` can see it and so
   * `watchtower:status` can report what a process is actually running
   * with, rather than what the config file says.
   */
  readonly fifo: boolean;

  private readonly queue: string;
  private readonly retryAfterSeconds: number;
  private readonly popBatchSize: number;
  private readonly dialect: Dialect;
  private readonly connectionName: string | undefined;
  private readonly onDefer: ((seconds: number) => Promise<void>) | undefined;

  constructor(
    private root: Kysely<any>,
    options: WatchtowerQueueDriverOptions = {},
  ) {
    this.queue = options.queue ?? "default";
    this.retryAfterSeconds = options.retryAfterSeconds ?? 90;
    this.popBatchSize = options.popBatchSize ?? 10;
    // Read off the connection rather than configured separately, so it
    // cannot drift from the engine actually on the other end.
    this.dialect = options.dialect ?? dialectOf(root);
    this.connectionName = options.connectionName;
    this.fifo = options.fifo ?? false;
    this.onDefer = options.onDefer;
  }

  /**
   * The connection this statement runs on: the active transaction when
   * one is open, else the root. Resolved per call, never captured, the
   * same rule `Model.resolveConnection()` follows — so a push inside
   * `DB.transaction()` commits with that transaction.
   */
  private get db(): Kysely<any> {
    return getActiveTransaction(this.root) ?? this.root;
  }

  async push(jobClass: string, state: JobState, options: PushOptions = {}): Promise<void> {
    const now = Date.now();
    const delaySeconds = options.delaySeconds ?? 0;

    await this.db
      .insertInto("watchtower_jobs")
      .values({
        // Minted here rather than by the caller: this is the first
        // moment the work exists, and every later row about it (a
        // release, a failure, a retry, every run record) carries this
        // same value forward.
        dispatch_id: randomUUIDv7(),
        queue: options.queue ?? this.queue,
        priority: priorityOf(options),
        job_class: jobClass,
        payload_json: JSON.stringify(state ?? null),
        chain_json: encodeChain(options.chain),
        attempts: 0,
        deferrals: 0,
        available_at: this.timestamp(now + delaySeconds * 1000),
        reserved_at: null,
        reserved_by: null,
        created_at: this.timestamp(now),
      })
      .execute();
  }

  /**
   * Push once the enclosing transaction commits, or immediately when
   * there is none.
   *
   * Scoped to *this driver's* connection: a transaction open on another
   * connection has nothing to do with the rows this job will read, so
   * deferring against it would be wrong.
   */
  async pushAfterCommit(
    jobClass: string,
    state: JobState,
    options: PushOptions = {},
  ): Promise<void> {
    await afterCommitOn(this.root, () => this.push(jobClass, state, options));
  }

  async pop(queue?: string): Promise<QueuedJob | undefined> {
    return this.dialect === "sqlite"
      ? this.popByConditionalUpdate(queue ?? this.queue)
      : this.popBySkipLocked(queue ?? this.queue);
  }

  /**
   * Reserve on behalf of a named worker, so a reclaim can report which
   * worker died holding the job.
   *
   * A separate entry point rather than an argument on `pop()` because
   * `QueueDriver.pop(queue?)` is the interface every other driver
   * implements and widening it here would make this driver
   * non-substitutable.
   */
  async popFor(queue: string | undefined, workerRunId: string): Promise<QueuedJob | undefined> {
    return this.dialect === "sqlite"
      ? this.popByConditionalUpdate(queue ?? this.queue, workerRunId)
      : this.popBySkipLocked(queue ?? this.queue, workerRunId);
  }

  /**
   * MySQL 8+/Postgres: lock one eligible row with `SKIP LOCKED` (so
   * concurrent workers pass over each other's rows rather than
   * blocking), mark it reserved, and commit, in one short transaction.
   */
  private async popBySkipLocked(
    queue: string,
    workerRunId?: string,
  ): Promise<QueuedJob | undefined> {
    return transaction(this.db, async (trx) => {
      const row = (await this.eligible(trx, queue)
        .selectAll()
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst()) as JobRow | undefined;

      if (!row) {
        return undefined;
      }

      const reclaimed = row.reserved_at !== null;
      await trx
        .updateTable("watchtower_jobs")
        .set({
          reserved_at: this.timestamp(Date.now()),
          reserved_by: workerRunId ?? null,
          // A reclaimed job burned an attempt on the worker that died
          // holding it. Counting it is what stops a job that reliably
          // kills its worker from cycling forever.
          ...(reclaimed ? { attempts: row.attempts + 1 } : {}),
        })
        .where("id", "=", row.id)
        .execute();

      return this.toQueuedJob(row, reclaimed ? row.attempts + 1 : row.attempts);
    });
  }

  /**
   * SQLite: read a bounded batch of candidates, then win one with a
   * conditional UPDATE. Bounded because an unbounded read parses the
   * entire backlog on every poll of every worker.
   */
  private async popByConditionalUpdate(
    queue: string,
    workerRunId?: string,
  ): Promise<QueuedJob | undefined> {
    const candidates = (await this.eligible(this.db, queue)
      .selectAll()
      .limit(this.popBatchSize)
      .execute()) as JobRow[];

    for (const candidate of candidates) {
      const reclaimed = candidate.reserved_at !== null;

      // The `reserved_at` predicate is the race guard: it must still
      // hold the value this worker read, or another worker got there
      // first.
      let update = this.db
        .updateTable("watchtower_jobs")
        .set({
          reserved_at: this.timestamp(Date.now()),
          reserved_by: workerRunId ?? null,
          ...(reclaimed ? { attempts: candidate.attempts + 1 } : {}),
        })
        .where("id", "=", candidate.id);

      update = reclaimed
        ? update.where("reserved_at", "=", candidate.reserved_at)
        : update.where("reserved_at", "is", null);

      const result = await update.executeTakeFirst();

      if (Number(result?.numUpdatedRows ?? 0) === 0) {
        continue;
      }

      return this.toQueuedJob(candidate, reclaimed ? candidate.attempts + 1 : candidate.attempts);
    }

    return undefined;
  }

  /**
   * Due, on this queue, and either unreserved or reserved so long ago
   * the worker holding it is presumed dead.
   *
   * Ordered `priority desc, available_at asc, id asc`. The index is
   * `(queue, priority, available_at, id)` and the column order there is
   * correctness rather than performance: on MySQL an `ORDER BY … LIMIT 1
   * FOR UPDATE SKIP LOCKED` needing a filesort locks every row it sorts,
   * so a second worker skips all of them and gets nothing.
   *
   * `id` is the final tiebreak specifically because it ascends with
   * insert order. `available_at` is truncated to whole seconds, so a
   * burst dispatched in one request ties on it and `id` alone decides
   * the order — which is why this table keys on an auto-increment column
   * and not a UUID.
   */
  private eligible(db: Kysely<any>, queue: string) {
    const now = this.timestamp(Date.now());
    const reservedCutoff = this.timestamp(Date.now() - this.retryAfterSeconds * 1000);

    return db
      .selectFrom("watchtower_jobs")
      .where("queue", "=", queue)
      .where("available_at", "<=", now)
      .where((eb: any) =>
        eb.or([eb("reserved_at", "is", null), eb("reserved_at", "<=", reservedCutoff)]),
      )
      .orderBy("priority", "desc")
      .orderBy("available_at", "asc")
      .orderBy("id", "asc");
  }

  /**
   * Put a job back to be retried in `delaySeconds`.
   *
   * **One method, one signature, and the job never knows which mode it is
   * in.** A job (or a middleware) always writes the same thing:
   *
   *     release(this, 60);
   *
   * and `fifo` — a property of this driver instance, set from the
   * process's config — decides what that means:
   *
   * - `fifo: false` (the default, and what every other driver does):
   *   retry this job after 60s, and run anything scheduled before it in
   *   the meantime.
   * - `fifo: true`: pause this whole process for 60s and retry this job
   *   before continuing with the others.
   *
   * The same job code runs correctly under both. That is deliberate and
   * is why this is not a second method or an extra argument: whether a
   * queue is strictly ordered is an operational decision about the
   * *queue*, not something a job should have an opinion on. A job that
   * had to ask for `releaseInPlace()` would be unable to move between a
   * `fifo` process and an ordinary one.
   *
   * The attempt is spent in both cases. Being rate-limited is a reason
   * this attempt did not complete, not a free pass, so a job that keeps
   * being released still fails once it exhausts `maxAttempts`.
   *
   * The only divergence is `available_at`. Reservation order is
   * `available_at asc, id asc`, so the ordinary path's `now + delay`
   * stamps a timestamp newer than everything already waiting and sends
   * the job to the back — measured, not inferred: with `A, B` queued,
   * `release(A, 0)` makes the next `pop()` return `B`. The `fifo` path
   * leaves the column alone, so the job keeps its place, and the waiting
   * is done by the process rather than by the row.
   */
  async release(job: QueuedJob, delaySeconds = 0): Promise<void> {
    const deferrals = isWatchtowerJob(job) ? job.deferrals : 0;

    await this.db
      .updateTable("watchtower_jobs")
      .set({
        // A release is a release: the attempt counts either way.
        attempts: job.attempts + 1,
        reserved_at: null,
        reserved_by: null,
        ...(this.fifo
          ? {
              // Counted separately from `attempts` for reporting and for
              // `maxDeferrals` — so a job stuck in a cooldown loop is
              // distinguishable from one failing outright.
              deferrals: deferrals + 1,
            }
          : {
              available_at: this.timestamp(Date.now() + delaySeconds * 1000),
            }),
      })
      .where("id", "=", job.id)
      .execute();

    // After the release commits, deliberately. The other order would
    // leave the process asleep over a job still marked reserved, which
    // the retry-after path then reclaims and charges a *second* attempt
    // for. This order's worst case is a cooldown that did not happen — a
    // retry too early, rather than a job that failed twice as fast as
    // configured.
    if (this.fifo) {
      await this.onDefer?.(delaySeconds);
    }
  }

  async delete(job: QueuedJob): Promise<void> {
    await this.db.deleteFrom("watchtower_jobs").where("id", "=", job.id).execute();
  }

  /**
   * Move a job to `watchtower_failed_jobs`, atomically.
   *
   * The insert and the delete are one transaction: a crash between them
   * would otherwise either leave the job live (to be reclaimed and fail
   * again, adding a duplicate failed row each time) or lose it entirely.
   *
   * `dispatch_id` is carried across so a retry rejoins the same run
   * history rather than starting a fresh chain, and the chain, queue and
   * priority so `queue:retry` restores the job exactly as it was — a
   * retry that drops the chain silently cancels every job behind it.
   */
  async fail(job: QueuedJob, error: Error): Promise<void> {
    const dispatchId = isWatchtowerJob(job) ? job.dispatchId : randomUUIDv7();

    await transaction(this.db, async (trx) => {
      const row = (await trx
        .selectFrom("watchtower_jobs")
        .select(["priority"])
        .where("id", "=", job.id)
        .executeTakeFirst()) as { priority: number } | undefined;

      await trx
        .insertInto("watchtower_failed_jobs")
        .values({
          id: job.id,
          dispatch_id: dispatchId,
          connection: this.connectionName ?? null,
          queue: job.queue ?? this.queue,
          priority: row?.priority ?? 0,
          job_class: job.jobClass,
          payload_json: JSON.stringify(job.state ?? null),
          chain_json: encodeChain(job.chain),
          // The full stack trace when available; the message is the
          // fallback for a thrown non-Error or a stackless one.
          error: error.stack ?? error.message,
          failed_at: this.timestamp(Date.now()),
        })
        .execute();

      await trx.deleteFrom("watchtower_jobs").where("id", "=", job.id).execute();
    });
  }

  /** How many jobs are on a queue: pending, reserved, due or not. */
  async size(queue?: string): Promise<number> {
    const row = await this.db
      .selectFrom("watchtower_jobs")
      .where("queue", "=", queue ?? this.queue)
      .select(({ fn }: any) => [fn.countAll().as("count")])
      .executeTakeFirst();

    return Number((row as { count?: unknown } | undefined)?.count ?? 0);
  }

  /** Delete every job on a queue without running it. Returns how many went. */
  async clear(queue?: string): Promise<number> {
    const result = await this.db
      .deleteFrom("watchtower_jobs")
      .where("queue", "=", queue ?? this.queue)
      .executeTakeFirst();

    return Number(result?.numDeletedRows ?? 0);
  }

  // ---------------------------------------------------------------------
  // FailedJobRepository
  // ---------------------------------------------------------------------

  async listFailed(): Promise<FailedJobRecord[]> {
    const rows = (await this.db
      .selectFrom("watchtower_failed_jobs")
      .selectAll()
      .orderBy("failed_at", "desc")
      .execute()) as FailedJobRow[];

    return rows.map((row) => this.toFailedRecord(row));
  }

  async findFailed(id: string): Promise<FailedJobRecord | undefined> {
    const row = (await this.db
      .selectFrom("watchtower_failed_jobs")
      .selectAll()
      .where("id", "=", failedJobKey(id))
      .executeTakeFirst()) as FailedJobRow | undefined;

    return row ? this.toFailedRecord(row) : undefined;
  }

  /**
   * Put a failed job back on its queue with `attempts` reset, and delete
   * the failed row, in one transaction — so a crash mid-retry can
   * neither requeue the job while keeping the failed row, nor lose both.
   *
   * `dispatch_id` is preserved, so the retried attempt lands in the same
   * run-history chain as the attempts that failed. The row's own key is
   * NOT preserved (the insert takes a fresh auto-increment value),
   * because `id` is the FIFO tiebreak and reusing an old one would place
   * the retry among jobs dispatched before it.
   */
  async retry(id: string): Promise<boolean> {
    return this.requeue("id", failedJobKey(id));
  }

  /**
   * Retry the failed job belonging to a dispatch, rather than by the
   * failed row's own key.
   *
   * This is what the dashboard needs. It lists run HISTORY, whose ids
   * belong to `watchtower_job_runs`, while `retry()` keys off
   * `watchtower_failed_jobs` — two tables with unrelated ids, so handing
   * a run id to `retry()` matches nothing and every retry 404s.
   * `dispatch_id` is the column both tables share, and it survives a
   * retry, which makes it the stable way to name "the work that failed"
   * from outside the queue.
   */
  async retryDispatch(dispatchId: string): Promise<boolean> {
    return this.requeue("dispatch_id", dispatchId);
  }

  /** Shared body of `retry()`/`retryDispatch()`: locate, requeue, delete. */
  private async requeue(column: "id" | "dispatch_id", value: string | bigint): Promise<boolean> {
    return transaction(this.db, async (trx) => {
      const row = (await trx
        .selectFrom("watchtower_failed_jobs")
        .selectAll()
        .where(column, "=", value)
        .executeTakeFirst()) as FailedJobRow | undefined;

      if (!row) {
        return false;
      }

      const now = Date.now();
      await trx
        .insertInto("watchtower_jobs")
        .values({
          dispatch_id: row.dispatch_id,
          queue: row.queue ?? this.queue,
          priority: row.priority,
          job_class: row.job_class,
          payload_json: row.payload_json,
          chain_json: row.chain_json ?? null,
          attempts: 0,
          deferrals: 0,
          available_at: this.timestamp(now),
          reserved_at: null,
          reserved_by: null,
          created_at: this.timestamp(now),
        })
        .execute();

      // By the row's own key, never the column matched above: a
      // `dispatch_id` retry must still delete exactly the row it requeued.
      await trx.deleteFrom("watchtower_failed_jobs").where("id", "=", row.id).execute();

      return true;
    });
  }

  async forget(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("watchtower_failed_jobs")
      .where("id", "=", failedJobKey(id))
      .executeTakeFirst();

    return Number(result?.numDeletedRows ?? 0) > 0;
  }

  async flush(olderThanHours?: number): Promise<number> {
    let query = this.db.deleteFrom("watchtower_failed_jobs");

    if (olderThanHours !== undefined) {
      // Through `timestamp()`, not a raw ISO string: on MySQL the
      // comparison would otherwise match nothing and the prune would
      // silently remove zero rows.
      query = query.where(
        "failed_at",
        "<",
        this.timestamp(Date.now() - olderThanHours * 3_600_000),
      );
    }

    const result = await query.executeTakeFirst();

    return Number(result?.numDeletedRows ?? 0);
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /**
   * A timestamp string every dialect can both store and *compare*,
   * truncated to whole seconds and space-separated for MySQL.
   *
   * Not `@mahiframework/database`'s `formatTimestamp()`, which keeps
   * sub-second precision — correctly, for a model's `created_at`. These
   * columns are declared without precision and are compared rather than
   * displayed, so two things bite:
   *
   * MySQL's `DATETIME` rejects an ISO-8601 `Z` string outright, so an
   * insert throws and a comparison matches nothing.
   *
   * Postgres *rounds* rather than truncates a second-precision column:
   * `…:02.642` is stored as `…:03`. A job pushed with no delay therefore
   * landed up to half a second in the future, `available_at <= now` was
   * false, and the queue looked permanently empty — on the engine most
   * likely to be in production.
   */
  private timestamp(epochMs: number): string {
    const truncated = new Date(epochMs).toISOString().slice(0, 19);

    return this.dialect === "mysql" ? truncated.replace("T", " ") : `${truncated}Z`;
  }

  private toFailedRecord(row: FailedJobRow): FailedJobRecord {
    const chain = row.chain_json ? (JSON.parse(row.chain_json) as ChainedJob[]) : undefined;

    return {
      // A bigint in the column and a string in the record, which is what
      // `queue:retry <id>` echoes and takes back.
      id: String(row.id),
      jobClass: row.job_class,
      payloadJson: row.payload_json,
      error: row.error,
      failedAt: row.failed_at,
      ...(row.connection ? { connection: row.connection } : {}),
      ...(row.queue ? { queue: row.queue } : {}),
      ...(chain && chain.length > 0 ? { chain } : {}),
    };
  }

  private toQueuedJob(row: JobRow, attempts: number): WatchtowerQueuedJob {
    const chain = row.chain_json ? (JSON.parse(row.chain_json) as ChainedJob[]) : undefined;

    return {
      id: row.id,
      jobClass: row.job_class,
      state: JSON.parse(row.payload_json) as JobState,
      attempts,
      queue: row.queue ?? this.queue,
      dispatchId: row.dispatch_id,
      deferrals: row.deferrals,
      ...(chain && chain.length > 0 ? { chain } : {}),
    };
  }
}

function encodeChain(chain: ChainedJob[] | undefined): string | null {
  return chain && chain.length > 0 ? JSON.stringify(chain) : null;
}

/**
 * The priority a push asked for, or 0 when it did not ask.
 *
 * `PushOptions.priority` is typed `number | undefined`, but the check is
 * not redundant: the value reaches here from an app, and an untyped
 * caller (plain JavaScript, a JSON config, a parsed query string) can
 * still hand over a string or `NaN`. `NaN` against a `smallint` is a hard
 * insert failure on Postgres, so a bad value must become 0 here rather
 * than a wrong sort order or a crash at the database.
 *
 * Truncated rather than rounded: `priority` is a band, and a fractional
 * one is a caller error rather than a request to round up into the band
 * above.
 */
function priorityOf(options: PushOptions): number {
  const priority: unknown = options.priority;

  return typeof priority === "number" && Number.isFinite(priority) ? Math.trunc(priority) : 0;
}

/**
 * Coerce a failed-job id to the `bigint` its column holds.
 *
 * The repository API takes a `string` because these ids come off a
 * command line, but the column is a 64-bit integer. Postgres rejects a
 * non-numeric string against a `bigint` with a hard error rather than
 * simply not matching, so a typo'd id would surface as a database
 * exception instead of "no such job".
 *
 * Anything that is not a decimal integer passes through untouched: it
 * cannot match a real id, so the caller gets `undefined`/`false`.
 */
function failedJobKey(id: string): string | bigint {
  return /^-?\d+$/.test(id) ? BigInt(id) : id;
}
