/**
 * The read model: what an operator (or a dashboard) can see.
 *
 * Plain serializable data throughout, no models and no class instances.
 * That is what lets the same shapes serve `watchtower:status`, the
 * dashboard's HTML render and its JSON poll without three
 * representations — and what lets an app consume `Watchtower.stats()`
 * from its own admin UI instead.
 *
 * Numbers are raw: `oldestPendingSeconds`, not `"18m 04s"`;
 * `failureRate: 0..1`, not `"0.73%"`. Formatting is a presentation
 * concern and belongs where the presentation is, so a caller rendering
 * into something other than the bundled theme is not stuck parsing
 * strings back.
 */

/** How healthy a thing is, computed here so the renderer only maps it to a style. */
export type Severity = "ok" | "warn" | "danger";

/** The overview payload, which is also what the dashboard polls. */
export interface WatchtowerStats {
  /** ISO 8601, so a stale page is detectable. */
  generatedAt: string;
  /** Whether every process is paused by an operator. */
  paused: boolean;
  totals: WatchtowerTotals;
  processes: ProcessStatus[];
  queues: QueueDepth[];
  jobTypes: JobTypeSummary[];
  recentFailures: JobRunSummary[];
  /** Config problems, from the same check `watchtower:check` runs. */
  warnings: string[];
}

export interface WatchtowerTotals {
  /** Jobs waiting across every claimed queue. */
  pending: number;
  /** Jobs currently reserved by a worker. */
  reserved: number;
  failedLastHour: number;
  completedLastHour: number;
  /** Age of the oldest waiting job, or null when nothing is waiting. */
  oldestPendingSeconds: number | null;
}

/**
 * What a configured process is doing.
 *
 * `state` is derived rather than stored: there is no process table, and
 * there should not be — two supervisors on two hosts would disagree about
 * one. It is computed from the pause key, the cooldown key and the live
 * worker heartbeats, which every host can read.
 */
export interface ProcessStatus {
  name: string;
  /** Read in priority order, highest first. */
  queues: string[];
  workersConfigured: number;
  /** From live heartbeats, so a crashed worker stops counting. */
  workersAlive: number;
  fifo: boolean;
  state: ProcessState;
  /** ISO 8601 while a cooldown is active. */
  deferredUntil: string | null;
  /** Jobs this process's workers have completed since they started. */
  processed: number;
  severity: Severity;
}

/**
 * `deferred` has no Horizon equivalent and is not an error: the process
 * is waiting on purpose, because an upstream service asked it to. It
 * reads as distinct from both healthy and broken for that reason.
 *
 * `stopped` means configured but nothing is running — which is normal
 * before `watchtower:work` starts and a problem after.
 */
export type ProcessState = "running" | "paused" | "deferred" | "stopped" | "idle";

export interface QueueDepth {
  queue: string;
  pending: number;
  oldestPendingSeconds: number | null;
  /** The process that drains it, or null — meaning nothing ever will. */
  claimedBy: string | null;
  severity: Severity;
}

/** Aggregated per job class over a rolling window. */
export interface JobTypeSummary {
  /** The registry name, e.g. `"app.jobs.sync-invoice"`. */
  name: string;
  /** The constructor name, for display. */
  className: string | null;
  completedCount: number;
  failedCount: number;
  /** 0..1. Zero when nothing has run. */
  failureRate: number;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  /** Completions per minute over the window. */
  throughputPerMinute: number;
  /**
   * Completions per equal-width bucket across the window, oldest first.
   *
   * Raw counts rather than scaled heights: a renderer wanting bars
   * chooses its own scale, and one wanting to label a bucket needs the
   * number. Always `TREND_BUCKETS` long, all zeroes when nothing
   * completed, so a caller can index it without checking.
   */
  trend: number[];
  lastSeenAt: string;
  severity: Severity;
}

/** How many buckets a job type's `trend` carries. */
export const TREND_BUCKETS = 8;

/** One attempt, flattened for display. */
export interface JobRunSummary {
  id: string;
  jobType: string;
  className: string | null;
  /** Stable across retries, so attempts at one dispatch group together. */
  dispatchId: string;
  /** Identifies THIS attempt and joins to the app's own log lines. */
  invocationId: string | null;
  process: string | null;
  queue: string | null;
  status: string;
  /** 1-based. */
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** UNTRUSTED: a stack trace, which may contain anything. Escape on render. */
  error: string | null;
}

/** Every attempt at one dispatch, so "failed 3x then succeeded" is one row. */
export interface AttemptChain {
  dispatchId: string;
  attempts: JobRunSummary[];
}

/** One job type, with its recent history. */
export interface JobTypeDetail extends JobTypeSummary {
  recentRuns: JobRunSummary[];
  attemptChains: AttemptChain[];
}

/**
 * Severity for a pending-queue age.
 *
 * Thresholds live here rather than in a renderer so every surface agrees,
 * and so changing "when is a queue late" is one edit. Generous on
 * purpose: a queue is not unhealthy for having work in it, only for
 * having work that has waited.
 */
export function severityForAge(seconds: number | null): Severity {
  if (seconds === null) {
    return "ok";
  }

  if (seconds >= 3600) {
    return "danger";
  }

  return seconds >= 300 ? "warn" : "ok";
}

/** Severity for a failure rate, 0..1. */
export function severityForFailureRate(rate: number): Severity {
  if (rate >= 0.25) {
    return "danger";
  }

  return rate >= 0.05 ? "warn" : "ok";
}

/** Severity for a process state. */
export function severityForState(state: ProcessState): Severity {
  switch (state) {
    case "stopped":
      return "danger";
    case "paused":
    case "deferred":
      return "warn";
    default:
      return "ok";
  }
}
