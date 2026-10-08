import { QUEUE_TOKEN, type Application } from "@mahiframework/core";
import { DateTime } from "@mahiframework/datetime";
import type { QueueDriver, QueueManager } from "@mahiframework/queue";
import { WatchtowerJobRun, type JobRunStatus } from "./models/watchtower-job-run.model.js";
import { WatchtowerJobType } from "./models/watchtower-job-type.model.js";
import { validateConfig } from "./validate-config.js";
import { WATCHTOWER_CONNECTION } from "./tokens.js";
import type { DeferralStore } from "./deferral.js";
import type { ResolvedProcessConfig, ResolvedWatchtowerConfig } from "./watchtower-config.js";
import {
  severityForAge,
  severityForFailureRate,
  severityForState,
  TREND_BUCKETS,
  type AttemptChain,
  type JobRunSummary,
  type JobTypeDetail,
  type JobTypeSummary,
  type ProcessState,
  type ProcessStatus,
  type QueueDepth,
  type WatchtowerStats,
} from "./stats.js";

/** How far back the rolling aggregates look, unless a caller says otherwise. */
const DEFAULT_WINDOW_HOURS = 24;

/** How many failures the overview carries. */
const RECENT_FAILURE_LIMIT = 10;

/** How many individual runs the job-detail view lists, newest first. */
const RECENT_RUN_LIMIT = 50;

/**
 * How many dispatches the job-detail view reconstructs full attempt
 * chains for. Each costs up to `maxAttempts` rows, so this bounds the
 * extra read rather than the run list it is derived from.
 */
const ATTEMPT_CHAIN_LIMIT = 20;

/**
 * Builds the read model from the tables, the cache and the queue driver.
 *
 * Separate from `WatchtowerManager` because it is all queries and no
 * state: the manager owns the gate and the config, this owns the reading.
 * Keeping them apart means a dashboard request cannot accidentally mutate
 * anything, and the queries are testable without a gate.
 */
export class StatsReader {
  constructor(
    private readonly app: Application,
    private readonly config: ResolvedWatchtowerConfig,
    private readonly deferrals: DeferralStore,
    private readonly runIdsFor: (process: string) => Promise<string[]>,
  ) {}

  /** The overview, which is also what the dashboard polls. */
  async stats(windowHours = DEFAULT_WINDOW_HOURS): Promise<WatchtowerStats> {
    const since = DateTime.now().subHours(windowHours);
    const lastHour = DateTime.now().subHours(1);

    const [queues, processes, jobTypes, recentFailures] = await Promise.all([
      this.queues(),
      this.processes(),
      this.jobTypes(since),
      this.recentFailures(),
    ]);

    const globalPause = await this.deferrals.waitState("");

    return {
      generatedAt: DateTime.now().toISOString(),
      paused: globalPause.paused,
      totals: {
        pending: queues.reduce((total, queue) => total + queue.pending, 0),
        reserved: await this.reservedCount(),
        failedLastHour: await this.countSince("failed", lastHour),
        completedLastHour: await this.countSince("completed", lastHour),
        oldestPendingSeconds: oldestOf(queues),
      },
      processes,
      queues,
      jobTypes,
      recentFailures,
      warnings: validateConfig(this.config).map((problem) => problem.message),
    };
  }

  /**
   * Per-process state, derived rather than stored.
   *
   * There is no process table and should not be: two supervisors on two
   * hosts would disagree about one. State comes from the pause key, the
   * cooldown key and the live heartbeats — all of which every host reads
   * the same way.
   */
  async processes(): Promise<ProcessStatus[]> {
    const statuses: ProcessStatus[] = [];

    for (const process of this.config.processes) {
      statuses.push(await this.processStatus(process));
    }

    return statuses;
  }

  private async processStatus(process: ResolvedProcessConfig): Promise<ProcessStatus> {
    const wait = await this.deferrals.waitState(process.name);
    const beats = await this.heartbeats(process.name);
    const state = processState(wait.paused, wait.deferredUntil, beats.length);

    return {
      name: process.name,
      queues: [...process.queues],
      workersConfigured: process.fifo ? 1 : process.workers,
      workersAlive: beats.length,
      fifo: process.fifo,
      state,
      deferredUntil:
        wait.deferredUntil === undefined
          ? null
          : DateTime.fromTimestamp(wait.deferredUntil).toISOString(),
      processed: beats.reduce((total, beat) => total + beat.processed, 0),
      severity: severityForState(state),
    };
  }

  private async heartbeats(processName: string): Promise<Array<{ processed: number }>> {
    const found: Array<{ processed: number }> = [];

    for (const runId of await this.runIdsFor(processName)) {
      const beat = await this.deferrals.heartbeatFor(runId);

      if (beat) {
        found.push(beat);
      }
    }

    return found;
  }

  /**
   * Depth per queue, including queues nothing drains.
   *
   * An unclaimed queue with work in it is silent and serious — the jobs
   * simply never run — so it is surfaced rather than omitted. Only queues
   * some process names are listed, because an arbitrary queue cannot be
   * discovered: `QueueDriver.size()` takes a name and there is no
   * enumeration.
   */
  async queues(): Promise<QueueDepth[]> {
    const driver = this.driver();
    const claimedBy = new Map<string, string>();

    for (const process of this.config.processes) {
      for (const queue of process.queues) {
        if (!claimedBy.has(queue)) {
          claimedBy.set(queue, process.name);
        }
      }
    }

    const depths: QueueDepth[] = [];

    for (const [queue, owner] of claimedBy) {
      const pending = driver?.size ? await driver.size(queue) : 0;
      const oldest = await this.oldestPendingSeconds(queue);

      depths.push({
        queue,
        pending,
        oldestPendingSeconds: oldest,
        claimedBy: owner,
        severity: severityForAge(oldest),
      });
    }

    return depths;
  }

  /** Rolling aggregates per job type, busiest first. */
  async jobTypes(since: DateTime): Promise<JobTypeSummary[]> {
    const types = await WatchtowerJobType.query().get();
    const summaries: JobTypeSummary[] = [];

    for (const type of types.all()) {
      summaries.push(await this.summarise(type, since));
    }

    return summaries.sort(
      (left, right) =>
        right.completedCount + right.failedCount - (left.completedCount + left.failedCount),
    );
  }

  /** One job type with its recent history, for the detail view. */
  async jobTypeDetail(
    name: string,
    windowHours = DEFAULT_WINDOW_HOURS,
  ): Promise<JobTypeDetail | undefined> {
    const type = await WatchtowerJobType.findByName(name).first();

    if (!type) {
      return undefined;
    }

    const since = DateTime.now().subHours(windowHours);
    const summary = await this.summarise(type, since);
    const runs = (
      await WatchtowerJobRun.forTypeSince(type.id, since).limit(RECENT_RUN_LIMIT).get()
    ).all();

    const recentRuns = runs.map(toRunSummary(type));

    return {
      ...summary,
      recentRuns,
      // Chains are built from a SEPARATE read, not from `recentRuns`.
      // That list is ordered newest-first and capped, so grouping it
      // would cut each chain's EARLIEST attempts — the ones that explain
      // how the job got into trouble — and then report the truncated
      // count as if it were the whole history. A job that released five
      // times before failing showed up as starting at attempt 2.
      attemptChains: chainsOf(await this.chainRuns(type, recentRuns)),
    };
  }

  /**
   * Every attempt belonging to the dispatches on show, so each chain is
   * complete even when its first attempt fell outside the capped
   * `recentRuns` read.
   *
   * Bounded by the dispatches already selected rather than by a row
   * count, which is what makes "complete" affordable: a chain is at most
   * `maxAttempts` long, so this reads a few rows per dispatch and never
   * the whole table.
   */
  private async chainRuns(
    type: WatchtowerJobType,
    recentRuns: JobRunSummary[],
  ): Promise<JobRunSummary[]> {
    const dispatchIds = [...new Set(recentRuns.map((run) => run.dispatchId))].slice(
      0,
      ATTEMPT_CHAIN_LIMIT,
    );

    if (dispatchIds.length === 0) {
      return [];
    }

    const runs = (
      await WatchtowerJobRun.query()
        .where("watchtower_job_type_id", type.id)
        .whereIn("dispatch_id", dispatchIds)
        .get()
    ).all();

    return runs.map(toRunSummary(type));
  }

  /** Failures across every job type, newest first. */
  async recentFailures(limit = RECENT_FAILURE_LIMIT): Promise<JobRunSummary[]> {
    const runs = (
      await WatchtowerJobRun.query()
        .where("status", "failed")
        .orderByDesc("finished_at")
        .limit(limit)
        .get()
    ).all();

    return this.withTypeNames(runs);
  }

  /**
   * Percentiles, counts and the completion trend for one type.
   *
   * Durations are read and sorted in memory rather than computed in SQL:
   * a percentile needs a window function, which is not portable across
   * the three engines this framework supports, and the row count per type
   * per window is bounded by what a queue can actually process.
   *
   * The trend is bucketed from the same rows for the same reason, and a
   * `GROUP BY` would be strictly worse: it is another round trip per job
   * type on top of a read that has already happened.
   */
  private async summarise(type: WatchtowerJobType, since: DateTime): Promise<JobTypeSummary> {
    const runs = (await WatchtowerJobRun.forTypeSince(type.id, since).get()).all();

    const completed = runs.filter((run) => run.status === "completed");
    const failed = runs.filter((run) => run.status === "failed");
    const durations = completed
      .map((run) => run.duration_ms)
      .filter((value): value is number => value !== null)
      .sort((left, right) => left - right);

    const finished = completed.length + failed.length;
    const failureRate = finished === 0 ? 0 : failed.length / finished;
    const now = DateTime.now();
    const windowMinutes = Math.max(1, Math.round((now.timestamp - since.timestamp) / 60_000));

    return {
      name: type.name,
      className: type.class_name,
      completedCount: completed.length,
      failedCount: failed.length,
      failureRate,
      p50DurationMs: percentile(durations, 0.5),
      p95DurationMs: percentile(durations, 0.95),
      throughputPerMinute: completed.length / windowMinutes,
      trend: trendOf(completed, since, now),
      lastSeenAt: type.last_seen_at.toISOString(),
      severity: severityForFailureRate(failureRate),
    };
  }

  /** Attach each run's job-type name, with one query per distinct type. */
  private async withTypeNames(runs: WatchtowerJobRun[]): Promise<JobRunSummary[]> {
    const typeIds = [...new Set(runs.map((run) => run.watchtower_job_type_id))];
    const types = new Map<string, WatchtowerJobType>();

    if (typeIds.length > 0) {
      for (const type of (await WatchtowerJobType.query().whereIn("id", typeIds).get()).all()) {
        types.set(type.id, type);
      }
    }

    return runs.map((run) => {
      const type = types.get(run.watchtower_job_type_id);

      return {
        id: run.id,
        jobType: type?.name ?? "(unknown)",
        className: type?.class_name ?? null,
        dispatchId: run.dispatch_id,
        invocationId: run.invocation_id,
        process: run.process,
        queue: run.queue,
        status: run.status,
        attempt: run.attempt,
        startedAt: run.started_at?.toISOString() ?? null,
        finishedAt: run.finished_at?.toISOString() ?? null,
        durationMs: run.duration_ms,
        error: run.error,
      };
    });
  }

  private async countSince(status: JobRunStatus, since: DateTime): Promise<number> {
    return WatchtowerJobRun.query()
      .where("status", status)
      .where("finished_at", ">=", since)
      .count();
  }

  private async reservedCount(): Promise<number> {
    return WatchtowerJobRun.query().where("status", "running").count();
  }

  /**
   * Age of the oldest waiting job on a queue.
   *
   * Read straight off `watchtower_jobs`, because the run history only
   * knows about jobs that have STARTED — and a job that has been waiting
   * three hours has, by definition, not.
   */
  private async oldestPendingSeconds(queue: string): Promise<number | null> {
    try {
      return await oldestPendingFor(this.app, queue);
    } catch {
      // The table may not exist — an app running only migration 0001 has
      // the history without the queue. A dashboard that 500s because one
      // number is unavailable is worse than one reporting null for it.
      return null;
    }
  }

  private driver(): QueueDriver | undefined {
    if (!this.app.has(QUEUE_TOKEN)) {
      return undefined;
    }

    try {
      return this.app.make<QueueManager>(QUEUE_TOKEN).connection(WATCHTOWER_CONNECTION);
    } catch {
      return undefined;
    }
  }
}

/**
 * The oldest unreserved job's age, in seconds.
 *
 * A raw query rather than a model, because `watchtower_jobs` has no model
 * — it is the driver's table and giving it one would invite application
 * code to write to it behind the driver's back.
 */
async function oldestPendingFor(app: Application, queue: string): Promise<number | null> {
  const database = app.make<{ driver: () => { kysely: any } }>("db");

  const row = (await database
    .driver()
    .kysely.selectFrom("watchtower_jobs")
    .select(["available_at"])
    .where("queue", "=", queue)
    .where("reserved_at", "is", null)
    .orderBy("available_at", "asc")
    .limit(1)
    .executeTakeFirst()) as { available_at: string } | undefined;

  if (!row) {
    return null;
  }

  const availableAt = Date.parse(
    row.available_at.includes("T") ? row.available_at : row.available_at.replace(" ", "T") + "Z",
  );

  if (!Number.isFinite(availableAt)) {
    return null;
  }

  return Math.max(0, Math.round((Date.now() - availableAt) / 1000));
}

/**
 * Derive a process's state.
 *
 * Order matters: a pause is an operator decision and outranks a cooldown,
 * which is transient. `stopped` (configured but nothing running) is
 * reported ahead of either, because neither a pause nor a cooldown means
 * anything when no worker is there to observe it.
 */
function processState(
  paused: boolean,
  deferredUntil: number | undefined,
  workersAlive: number,
): ProcessState {
  if (workersAlive === 0) {
    return "stopped";
  }

  if (paused) {
    return "paused";
  }

  return deferredUntil === undefined ? "running" : "deferred";
}

/**
 * The nearest-rank percentile of a sorted list.
 *
 * Nearest-rank rather than interpolated: these are observed durations, so
 * a p95 that is a real measurement beats one that is an average of two.
 */
function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) {
    return null;
  }

  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);

  return sorted[Math.max(0, index)] ?? null;
}

/**
 * Completions per equal-width bucket across the window, oldest first.
 *
 * Counts rather than scaled heights, so a renderer chooses its own scale
 * and a caller can read a bucket as a number. The bucket index is clamped
 * at both ends rather than the array widened: a run landing exactly at
 * `now` would otherwise index one past the last bucket.
 *
 * Completions only. Stacking failures would need a second series and a
 * second colour, and the failure rate already has its own column.
 */
function trendOf(completed: WatchtowerJobRun[], since: DateTime, now: DateTime): number[] {
  const counts = new Array<number>(TREND_BUCKETS).fill(0);
  const spanMs = now.timestamp - since.timestamp;

  // A zero-width window cannot be bucketed, and dividing by it would put
  // every run in an `Infinity` bucket.
  if (spanMs <= 0) {
    return counts;
  }

  for (const run of completed) {
    // `forTypeSince` filters on `started_at`, so a completed row in this
    // window always has one. Bucketed on it rather than `finished_at`
    // because that is the column the window itself was selected on.
    const offset = (run.started_at?.timestamp ?? since.timestamp) - since.timestamp;
    const index = Math.min(TREND_BUCKETS - 1, Math.floor((offset / spanMs) * TREND_BUCKETS));
    // Clamped at both ends, so a run timestamped outside the window (a
    // clock skewed between two hosts) lands in an end bucket rather than
    // off the array.
    const bucket = Math.max(0, index);

    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }

  return counts;
}

/** Group attempts by dispatch, newest chain first, attempts in order. */
function chainsOf(runs: JobRunSummary[]): AttemptChain[] {
  const chains = new Map<string, JobRunSummary[]>();

  for (const run of runs) {
    chains.set(run.dispatchId, [...(chains.get(run.dispatchId) ?? []), run]);
  }

  return [...chains.entries()].map(([dispatchId, attempts]) => ({
    dispatchId,
    attempts: [...attempts].sort((left, right) => left.attempt - right.attempt),
  }));
}

function toRunSummary(type: WatchtowerJobType): (run: WatchtowerJobRun) => JobRunSummary {
  return (run) => ({
    id: run.id,
    jobType: type.name,
    className: type.class_name,
    dispatchId: run.dispatch_id,
    invocationId: run.invocation_id,
    process: run.process,
    queue: run.queue,
    status: run.status,
    attempt: run.attempt,
    startedAt: run.started_at?.toISOString() ?? null,
    finishedAt: run.finished_at?.toISOString() ?? null,
    durationMs: run.duration_ms,
    error: run.error,
  });
}

function oldestOf(queues: QueueDepth[]): number | null {
  const ages = queues
    .map((queue) => queue.oldestPendingSeconds)
    .filter((value): value is number => value !== null);

  return ages.length === 0 ? null : Math.max(...ages);
}
