import type { Kysely } from "kysely";
import {
  afterCommitOn,
  dialectOf,
  getActiveTransaction,
  transaction,
} from "@mahiframework/database";
import type { Dialect } from "@mahiframework/database";
import type { QueueDriver, QueuedJob, PushOptions, ChainedJob } from "../queue-driver.js";
import type { JobState } from "../job-serialization.js";
import type { FailedJobRepository, FailedJobRecord } from "../failed-job-repository.js";
import { Snowflake } from "@mahiframework/snowflake";

interface JobRow {
  id: bigint;
  queue: string;
  job_class: string;
  payload_json: string;
  attempts: number;
  available_at: string;
  reserved_at: string | null;
  created_at: string;
  chain_json: string | null;
}

interface FailedJobRow {
  id: bigint;
  connection: string | null;
  queue: string | null;
  job_class: string;
  payload_json: string;
  chain_json: string | null;
  error: string;
  failed_at: string;
}

export interface DatabaseQueueDriverOptions {
  /** Which logical queue (the `jobs.queue` column) this driver reads and writes. Default `"default"`. */
  queue?: string;
  /**
   * Seconds after which a reserved job is presumed abandoned and becomes
   * eligible for `pop()` again. **This is the crash-recovery mechanism**:
   * a worker killed with `-9` mid-job leaves `reserved_at` set and
   * nothing else would ever clear it, so without a visibility timeout the
   * job is stranded forever, not in `failed_jobs`, invisible to
   * `queue:failed`, simply gone.
   *
   * Default 90s, matching Laravel's `retry_after`. It must be **longer
   * than the longest a job can legitimately take**, including its own
   * `timeout()`: reclaiming a job that is still running means running it
   * twice concurrently.
   */
  retryAfterSeconds?: number;
  /**
   * How many candidate rows a single `pop()` reads before giving up for
   * this poll. Only relevant on SQLite, where the reserve is
   * select-then-conditional-update and a lost race moves to the next
   * candidate; MySQL/Postgres reserve with `SKIP LOCKED` and never
   * contend. Default 10, enough that a few concurrent workers all get a
   * job on the first poll, small enough that it can't degrade into
   * reading the backlog.
   */
  popBatchSize?: number;
  /**
   * Override the engine this connection speaks, which selects the
   * reservation strategy: `SELECT ... FOR UPDATE SKIP LOCKED` on MySQL
   * 8+/Postgres (one round-trip, no contention), the portable
   * select-then-conditional-update on SQLite (whose single writer makes
   * row locks meaningless anyway).
   *
   * Normally omitted. It is read from the connection itself via
   * `dialectOf()`, so it cannot drift from reality. Pass it only for a
   * `Kysely` this framework didn't build, where `dialectOf()` has nothing
   * to look up and conservatively answers `"sqlite"`.
   */
  dialect?: Dialect;
  /**
   * The connection name recorded on failed jobs, so `queue:retry` can put
   * a job back where it came from. Purely informational to the driver.
   */
  connectionName?: string;
}

/**
 * Persists jobs in a `jobs` table via the app's existing Kysely
 * connection, no new infrastructure beyond the database the app already
 * has, mirroring Laravel's `database` queue driver. See
 * `../migrations/0001_create_jobs_table.ts` and
 * `../migrations/0002_queue_reliability.ts` for the schema.
 *
 * ## Reserving a job
 *
 * A row is eligible when it is due (`available_at <= now`) and either
 * unreserved or reserved longer ago than `retryAfterSeconds`. The second
 * half is the visibility timeout: it is what lets a job survive the
 * worker holding it being killed, at the cost of at-least-once delivery
 * (a job whose worker merely *stalled* past `retryAfter` runs twice,
 * make `handle()` idempotent).
 *
 * How the reservation is made depends on the dialect:
 *
 *   - **MySQL 8+/Postgres**, `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1`
 *     inside a transaction, then `UPDATE`. Concurrent workers skip each
 *     other's locked rows instead of contending, so throughput scales
 *     with worker count.
 *   - **SQLite**, read a small batch of candidates, then reserve one
 *     with `UPDATE ... WHERE id = ? AND reserved_at IS [what we read]`.
 *     The conditional is the race guard: if another worker won, the
 *     update matches zero rows and this one tries the next candidate.
 *     SQLite serialises writers anyway, so there is nothing to gain from
 *     row locks.
 *
 * Either way a reclaimed job comes back with `attempts` incremented, so a
 * job that repeatedly kills its worker eventually lands in `failed_jobs`
 * instead of looping forever.
 *
 * ## Ordering
 *
 * Jobs due at the same time run in the order they were pushed. That
 * falls out of `id` being a snowflake — time-ordered by construction —
 * since `available_at` is only second-precision and cannot separate a
 * burst dispatched within one.
 *
 * It is not a guarantee across *workers*: several workers pop in order
 * but finish whenever they finish. Order of execution is only order of
 * dispatch when a single worker is draining the queue.
 *
 * ## Transactions
 *
 * Every statement resolves its connection at call time via
 * `getActiveTransaction() ?? root`, exactly like `Model` and
 * `QueryBuilder`. A job pushed inside `DB.transaction()` therefore commits
 * (or rolls back) *with* that transaction on every engine. Holding the
 * root connection instead would commit the row independently on
 * MySQL/Postgres, and a worker could pop a job referencing rows that do
 * not exist yet.
 *
 * That still leaves the race where the job is visible the instant the
 * transaction commits but *before* the pushing code has finished; use
 * `Bus.dispatch(job, { afterCommit: true })` (or `pushAfterCommit`) to
 * defer the push until the outermost commit instead.
 */
export class DatabaseQueueDriver implements QueueDriver, FailedJobRepository {
  private readonly queue: string;
  private readonly retryAfterSeconds: number;
  private readonly popBatchSize: number;
  private readonly dialect: Dialect;
  private readonly connectionName: string | undefined;

  constructor(
    private root: Kysely<any>,
    options: DatabaseQueueDriverOptions = {},
  ) {
    this.queue = options.queue ?? "default";
    this.retryAfterSeconds = options.retryAfterSeconds ?? 90;
    this.popBatchSize = options.popBatchSize ?? 10;
    // Read off the connection rather than configured separately, so it
    // cannot drift from the engine actually on the other end.
    this.dialect = options.dialect ?? dialectOf(root);
    this.connectionName = options.connectionName;
  }

  /**
   * The connection this statement runs on: the active transaction when
   * one is open, else the root. Resolved per-call, never captured, the
   * same rule `Model.resolveConnection()` and `SchemaBuilder` follow.
   */
  private get db(): Kysely<any> {
    return getActiveTransaction(this.root) ?? this.root;
  }

  async push(jobClass: string, state: JobState, options: PushOptions = {}): Promise<void> {
    const now = Date.now();
    const delaySeconds = options.delaySeconds ?? 0;

    await this.db
      .insertInto("jobs")
      .values({
        id: await Snowflake.id("job"),
        queue: options.queue ?? this.queue,
        job_class: jobClass,
        payload_json: JSON.stringify(state ?? null),
        attempts: 0,
        available_at: this.timestamp(now + delaySeconds * 1000),
        reserved_at: null,
        created_at: this.timestamp(now),
        chain_json: encodeChain(options.chain),
      })
      .execute();
  }

  /**
   * Push once the enclosing transaction commits, or immediately when
   * there is none. What `Bus.dispatch(job, { afterCommit: true })` calls.
   *
   * Scoped to *this driver's* connection: a transaction open on some
   * other connection has nothing to do with the rows this job will read,
   * so deferring against it would be wrong.
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
   * MySQL 8+/Postgres: lock one eligible row with `SKIP LOCKED` (so
   * concurrent workers pass over each other's rows rather than blocking),
   * mark it reserved, and commit, all in one short transaction.
   *
   * `transaction()` here nests as a savepoint if the caller already has
   * one open, which keeps this correct (if pointless) inside a wrapping
   * transaction rather than deadlocking on a second connection.
   */
  private async popBySkipLocked(queue: string): Promise<QueuedJob | undefined> {
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
        .updateTable("jobs")
        .set({
          reserved_at: this.timestamp(Date.now()),
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
   * conditional UPDATE. Bounded because an unbounded `selectAll()` reads
   * (and JSON-parses) the entire backlog on every poll of every worker.
   */
  private async popByConditionalUpdate(queue: string): Promise<QueuedJob | undefined> {
    const candidates = (await this.eligible(this.db, queue)
      .selectAll()
      .limit(this.popBatchSize)
      .execute()) as JobRow[];

    for (const candidate of candidates) {
      const reclaimed = candidate.reserved_at !== null;

      // The `reserved_at` predicate is the race guard: it must still hold
      // the value this worker read, or another worker got there first.
      let update = this.db
        .updateTable("jobs")
        .set({
          reserved_at: this.timestamp(Date.now()),
          ...(reclaimed ? { attempts: candidate.attempts + 1 } : {}),
        })
        .where("id", "=", candidate.id);

      update = reclaimed
        ? update.where("reserved_at", "=", candidate.reserved_at)
        : update.where("reserved_at", "is", null);

      const result = await update.executeTakeFirst();

      if (Number(result?.numUpdatedRows ?? 0) === 0) {
        continue;
      } // lost the race, next candidate

      return this.toQueuedJob(candidate, reclaimed ? candidate.attempts + 1 : candidate.attempts);
    }

    return undefined;
  }

  /**
   * The eligibility predicate, shared by both reservation strategies:
   * due, on this queue, and either unreserved or reserved so long ago the
   * worker holding it is presumed dead.
   *
   * Ordered by `available_at` so the queue is FIFO by due time, then by
   * `id`. Without a tiebreak, two rows sharing a timestamp come back in
   * whatever order the engine feels like, which makes concurrent workers
   * collide on the same row far more often than they need to.
   *
   * `id` is the tiebreak specifically because a snowflake sorts by the
   * time it was minted. `available_at` is truncated to whole seconds, so
   * a burst dispatched in one request ties on it and `id` alone decides
   * the order — with a random id that made the burst run shuffled, which
   * is not what FIFO promises.
   */
  private eligible(db: Kysely<any>, queue: string) {
    const now = this.timestamp(Date.now());
    const reservedCutoff = this.timestamp(Date.now() - this.retryAfterSeconds * 1000);

    return db
      .selectFrom("jobs")
      .where("queue", "=", queue)
      .where("available_at", "<=", now)
      .where((eb: any) =>
        eb.or([eb("reserved_at", "is", null), eb("reserved_at", "<=", reservedCutoff)]),
      )
      .orderBy("available_at", "asc")
      .orderBy("id", "asc");
  }

  async release(job: QueuedJob, delaySeconds = 0): Promise<void> {
    await this.db
      .updateTable("jobs")
      .set({
        attempts: job.attempts + 1,
        available_at: this.timestamp(Date.now() + delaySeconds * 1000),
        reserved_at: null,
      })
      .where("id", "=", job.id)
      .execute();
  }

  async delete(job: QueuedJob): Promise<void> {
    await this.db.deleteFrom("jobs").where("id", "=", job.id).execute();
  }

  /**
   * Move a job to `failed_jobs`, **atomically**. The insert and the
   * delete are one transaction: a crash between them would otherwise
   * either leave the job live (to be reclaimed and fail again, adding a
   * duplicate failed row each time) or lose it entirely.
   *
   * The chain, connection and queue are recorded alongside so
   * `queue:retry` can restore the job exactly as it was. A retry that
   * drops the chain silently cancels every job queued behind it.
   */
  async fail(job: QueuedJob, error: Error): Promise<void> {
    await transaction(this.db, async (trx) => {
      await trx
        .insertInto("failed_jobs")
        .values({
          id: job.id,
          connection: this.connectionName ?? null,
          queue: job.queue ?? this.queue,
          job_class: job.jobClass,
          payload_json: JSON.stringify(job.state ?? null),
          chain_json: encodeChain(job.chain),
          // Store the full stack trace when available (Laravel's `error`
          // column keeps the whole trace), falls back to the message for a
          // thrown non-Error or a stackless Error.
          error: error.stack ?? error.message,
          failed_at: this.timestamp(Date.now()),
        })
        .execute();

      await trx.deleteFrom("jobs").where("id", "=", job.id).execute();
    });
  }

  /** How many jobs are waiting (not reserved, not necessarily due) on a queue. */
  async size(queue?: string): Promise<number> {
    const row = await this.db
      .selectFrom("jobs")
      .where("queue", "=", queue ?? this.queue)
      .select(({ fn }: any) => [fn.countAll().as("count")])
      .executeTakeFirst();

    return Number((row as { count?: unknown } | undefined)?.count ?? 0);
  }

  /**
   * Delete every job on a queue without running it, Laravel's
   * `queue:clear`. Returns how many were removed.
   */
  async clear(queue?: string): Promise<number> {
    const result = await this.db
      .deleteFrom("jobs")
      .where("queue", "=", queue ?? this.queue)
      .executeTakeFirst();

    return Number(result?.numDeletedRows ?? 0);
  }

  async listFailed(): Promise<FailedJobRecord[]> {
    const rows = (await this.db
      .selectFrom("failed_jobs")
      .selectAll()
      .orderBy("failed_at", "desc")
      .execute()) as FailedJobRow[];

    return rows.map((row) => this.toFailedRecord(row));
  }

  async findFailed(id: string): Promise<FailedJobRecord | undefined> {
    const row = (await this.db
      .selectFrom("failed_jobs")
      .selectAll()
      .where("id", "=", failedJobKey(id))
      .executeTakeFirst()) as FailedJobRow | undefined;

    return row ? this.toFailedRecord(row) : undefined;
  }

  /**
   * Push a failed job's stored payload back onto the live `jobs` table
   * with a fresh id and `attempts` reset to 0, then delete the
   * failed-jobs row, in one transaction, so a crash mid-retry can't
   * both requeue the job and keep the failed row (or lose both).
   *
   * The job goes back onto the queue it failed on, carrying its chain, so
   * the work queued behind it still runs. Returns false if no failed job
   * with that id exists.
   */
  async retry(id: string): Promise<boolean> {
    return transaction(this.db, async (trx) => {
      const row = (await trx
        .selectFrom("failed_jobs")
        .selectAll()
        .where("id", "=", failedJobKey(id))
        .executeTakeFirst()) as FailedJobRow | undefined;

      if (!row) {
        return false;
      }

      const now = Date.now();
      await trx
        .insertInto("jobs")
        .values({
          id: await Snowflake.id("job"),
          queue: row.queue ?? this.queue,
          job_class: row.job_class,
          payload_json: row.payload_json,
          attempts: 0,
          available_at: this.timestamp(now),
          reserved_at: null,
          created_at: this.timestamp(now),
          chain_json: row.chain_json ?? null,
        })
        .execute();

      await trx.deleteFrom("failed_jobs").where("id", "=", failedJobKey(id)).execute();

      return true;
    });
  }

  async forget(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("failed_jobs")
      .where("id", "=", failedJobKey(id))
      .executeTakeFirst();

    return Number(result?.numDeletedRows ?? 0) > 0;
  }

  async flush(olderThanHours?: number): Promise<number> {
    let query = this.db.deleteFrom("failed_jobs");

    if (olderThanHours !== undefined) {
      // Via `timestamp()`, not a raw ISO string: MySQL won't compare a
      // DATETIME against one, so `failed_at < cutoff` would match nothing
      // and `queue:flush --hours` would silently prune nothing at all.
      const cutoff = this.timestamp(Date.now() - olderThanHours * 3600 * 1000);
      query = query.where("failed_at", "<", cutoff);
    }

    const result = await query.executeTakeFirst();

    return Number(result?.numDeletedRows ?? 0);
  }

  /**
   * A timestamp string every dialect can both store and *compare*,
   * always **truncated to whole seconds**, and space-separated for MySQL.
   *
   * Both halves matter:
   *
   * **The `Z` suffix.** MySQL's `DATETIME` rejects an ISO-8601 UTC string
   * outright ("Incorrect datetime value"), so an insert throws and a
   * comparison matches nothing. MySQL needs `YYYY-MM-DD HH:MM:SS`.
   *
   * **The milliseconds.** The schema stores these columns as second
   * precision (`timestamp(0)` on Postgres, `DATETIME` on MySQL), and
   * Postgres *rounds* rather than truncates: `…:02.642` is stored as
   * `…:03`. A job pushed with no delay therefore landed up to half a
   * second in the future and `available_at <= now` was false, the queue
   * looked permanently empty, on the engine most likely to be in
   * production. Truncating here means what we store is exactly what we
   * later compare against.
   *
   * That second point is why this is not `@mahiframework/database`'s
   * `formatTimestamp()`, which is otherwise the same function: it keeps
   * sub-second precision, correctly, because a model's `created_at` may
   * be a `timestamp(3)` and coarsening every model's timestamps to whole
   * seconds would be wrong. These four columns are declared without
   * precision and are *compared*, not just displayed, so the rounding
   * matters here and nowhere else.
   */
  private timestamp(epochMs: number): string {
    // `slice(0, 19)` drops `.mmmZ`, leaving `YYYY-MM-DDTHH:MM:SS`.
    const truncated = new Date(epochMs).toISOString().slice(0, 19);

    return this.dialect === "mysql" ? truncated.replace("T", " ") : `${truncated}Z`;
  }

  private toFailedRecord(row: FailedJobRow): FailedJobRecord {
    const chain = row.chain_json ? (JSON.parse(row.chain_json) as ChainedJob[]) : undefined;

    return {
      // `id` is a snowflake in the column and a string in the public
      // record, which is what `queue:retry <id>` echoes and takes back.
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

  private toQueuedJob(row: JobRow, attempts: number): QueuedJob {
    const chain = row.chain_json ? (JSON.parse(row.chain_json) as ChainedJob[]) : undefined;

    return {
      id: row.id,
      jobClass: row.job_class,
      state: JSON.parse(row.payload_json) as JobState,
      attempts,
      queue: row.queue ?? this.queue,
      ...(chain && chain.length > 0 ? { chain } : {}),
    };
  }
}

function encodeChain(chain: ChainedJob[] | undefined): string | null {
  return chain && chain.length > 0 ? JSON.stringify(chain) : null;
}

/**
 * Coerce a failed-job id to the `bigint` its column holds.
 *
 * The repository API takes a `string` because these ids come off a
 * command line (`queue:forget <id>`), but `failed_jobs.id` is a
 * snowflake. Postgres rejects a non-numeric string against a `bigint`
 * with a hard error rather than simply not matching, so a typo'd id
 * would surface as a database exception instead of "no such job".
 *
 * Anything that isn't a decimal integer is passed through untouched: it
 * cannot match a snowflake, so the caller gets `undefined`/`false`.
 */
function failedJobKey(id: string): string | bigint {
  return /^-?\d+$/.test(id) ? BigInt(id) : id;
}
