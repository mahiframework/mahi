import type { HttpPipe } from "@mahiframework/http";

/**
 * Renders the dashboard page.
 *
 * Declared here rather than imported so the config module stays loadable
 * before anything else exists; the bundled implementation and the
 * plain-data page it takes live under `dashboard/`.
 */
export interface DashboardTheme {
  render(page: DashboardPage): string;
}

/**
 * The page a theme renders: plain data, no HTML.
 *
 * Widened to `unknown` until the section union lands, so the seam is
 * declared without pinning a shape the renderer has not needed yet.
 */
export type DashboardPage = Record<string, unknown>;

/**
 * The `"watchtower"` config namespace.
 *
 * Every field has a default except `processes`, so an app that writes
 * nothing gets a single worker on the `default` queue. The dashboard is
 * the one feature gated on key presence rather than a flag — see
 * `dashboard`.
 *
 * NOTHING HERE IMPORTS A MODEL. A `config/*.ts` is loaded before
 * `app.bootstrap()`, so importing a model would pull the ORM into
 * config-load time. Middleware factories are fine: `authenticate()`
 * returns a closure that resolves the container at request time.
 */
export interface WatchtowerConfig {
  /**
   * Where pending jobs live.
   *
   * `"database"` is the `watchtower_jobs` table this package owns and the
   * only option supporting `fifo` and within-queue `priority`.
   * `"redis"` reuses `@mahiframework/redis`'s existing queue driver
   * unchanged, which is faster and loses both.
   */
  storage?: "database" | "redis";

  /** The worker processes the supervisor runs. One entry per pool. */
  processes?: WatchtowerProcessConfig[];

  /** Run-history recording. */
  recording?: WatchtowerRecordingConfig;

  /** Supervisor behaviour. */
  supervisor?: WatchtowerSupervisorConfig;

  /**
   * Set (even to `{}`) to register the dashboard routes. Omit the key
   * entirely and NO routes are registered.
   *
   * Key presence is the switch rather than `dashboard: { enabled: false }`,
   * matching `impersonation.routes` and `http.healthCheck`. In this
   * framework an opt-in feature gates on its key existing; only
   * on-by-default behaviour (`http.securityHeaders`) uses an `enabled`
   * flag.
   *
   * Setting this does NOT grant anyone access. Authorization is
   * `Watchtower.gate()`, which denies everyone until registered.
   */
  dashboard?: WatchtowerDashboardConfig;
}

/**
 * One supervised pool: a name, the queues it drains, and how many
 * children run it.
 *
 * A process is the unit of throttling. Two jobs that talk to the same
 * rate-limited API belong on one process so a cooldown covers both; two
 * unrelated workloads belong on separate processes so one backing up
 * cannot starve the other.
 */
export interface WatchtowerProcessConfig {
  /** Operator-facing name, unique across processes. Appears in logs and the dashboard. */
  name: string;

  /**
   * The queues this process drains, **highest priority first**.
   *
   * Each poll tries them in order and takes the first job available, so
   * a job on `queues[0]` always beats one on `queues[1]`. That is
   * strict priority, not weighted: a permanently busy first queue
   * starves the rest, which is sometimes exactly right and sometimes a
   * mistake. Split the workload across processes when it is a mistake.
   */
  queues: string[];

  /** Child processes to run. Defaults to 1. Forced to 1 when `fifo`. */
  workers?: number;

  /**
   * Make a release pause the whole process instead of moving on to the
   * next job. Off by default.
   *
   * This reinterprets what a `ReleaseJobError(60)` means, and ONLY
   * that — the attempt is spent either way, so a job that keeps being
   * released still fails once it exhausts `maxAttempts`.
   *
   * Off (the default, and how `queue:work` behaves):
   *   "Retry this job after 60s, and meanwhile run anything scheduled
   *   before it."
   *
   * On:
   *   "Pause this process for 60s and retry this job before continuing
   *   with the others."
   *
   * The second is right for a shared rate limit. An upstream 429 means
   * the next job would be rejected too, so working ahead just spends
   * attempts against a service that already said to wait.
   *
   * Requires a driver that can release a job without it losing its
   * queue position (so not `storage: "redis"`) and a cache store shared
   * across processes. Both are errors rather than silent downgrades,
   * because the failure mode is a process that keeps hammering an API
   * the config said to back off from.
   */
  fifo?: boolean;

  /**
   * How many times one job may pause its process before a release
   * behaves normally again. Defaults to 10.
   *
   * The attempt budget already bounds how long a job can live, so this
   * is not about the job — it is about the PROCESS. A job allowed 25
   * tries that is released every time would hold its whole process idle
   * for 25 cooldowns while the rest of the queue waits behind it. Past
   * this count the release reverts to the ordinary form: the job goes to
   * the back, the process keeps working, and a warning is logged.
   */
  maxDeferrals?: number;

  /** Attempts before a job fails, overriding each job's `maxAttempts`. */
  tries?: number;

  /** Soft timeout in seconds for jobs that define no `timeout()`. */
  timeout?: number;

  /** Retry delay in seconds for jobs that define no `backoff()`. */
  backoff?: number;

  /** Stop a worker once its heap exceeds this many MiB. Defaults to 128. */
  memory?: number;

  /** Stop a worker after processing this many jobs. */
  maxJobs?: number;

  /** Stop a worker after this many seconds. */
  maxTime?: number;

  /** Seconds a worker sleeps when every queue is empty. Defaults to 3. */
  sleep?: number;
}

export interface WatchtowerRecordingConfig {
  /** Record run history at all. Defaults to `true`. */
  enabled?: boolean;

  /**
   * Write history through the queue rather than inline. Defaults to
   * `false`.
   *
   * Inline costs three or four extra statements on the worker's hot
   * path, per job. Queued moves them off it, at the cost of the history
   * lagging and being lossy under load — the right trade for
   * observability, and the wrong one for an audit log (use
   * `@mahiframework/activity-logs` when the record must be complete).
   *
   * Inline is the DEFAULT despite being slower, because queued needs a
   * process draining `queue` and an app that configures nothing has
   * none. Defaulting to queued would mean the zero-config install
   * records nothing at all and shows an empty dashboard with no error —
   * exactly the silent failure this package exists to surface. An app at
   * the volume where the inline writes matter is already configuring
   * processes explicitly and can add one for this.
   */
  queued?: boolean;

  /**
   * The queue history jobs are pushed to. Defaults to
   * `"watchtower-metrics"`.
   *
   * Deliberately not the default queue: metrics sharing a queue with
   * real work means a backed-up queue also blinds the dashboard that
   * would have shown you it was backed up. Some process must claim this
   * queue or nothing is recorded; `watchtower:check` warns when none
   * does.
   */
  queue?: string;

  /** The queue connection history jobs are pushed to. The app's default when omitted. */
  connection?: string;

  /**
   * Days of history to keep. Defaults to 7.
   *
   * `watchtower_job_runs` grows by one row per job per attempt, so this
   * is not optional maintenance. `watchtower:prune` applies it.
   */
  retentionDays?: number;
}

export interface WatchtowerSupervisorConfig {
  /**
   * Seconds to wait for children to finish their current job on
   * shutdown before killing them. Defaults to 30.
   *
   * A child stops after its in-flight job on SIGTERM, so this is the
   * budget for that job. Too short and a rolling deploy kills work
   * mid-flight; too long and an orchestrator's own timeout kills the
   * supervisor first.
   */
  shutdownTimeoutSeconds?: number;

  /** Ceiling on the restart backoff, in seconds. Defaults to 60. */
  restartBackoffCeilingSeconds?: number;

  /**
   * Restarts within `crashLoopWindowSeconds` before the supervisor stops
   * restarting a process. Defaults to 10.
   */
  crashLoopThreshold?: number;

  /** The window the crash-loop threshold is counted over. Defaults to 60. */
  crashLoopWindowSeconds?: number;
}

export interface WatchtowerDashboardConfig {
  /** Path prefix the dashboard mounts at. Defaults to `"/watchtower"`. */
  prefix?: string;

  /**
   * AUTHENTICATION pipes — establishing who the user is. A session
   * guard, an SSO pipe.
   *
   * NOT authorization. `Watchtower.gate()` decides who may view the
   * dashboard and runs after these, and it cannot be replaced or
   * disabled from config. Leaving this empty is fine; the gate still
   * refuses everyone until registered.
   */
  middleware?: HttpPipe[];

  /** Seconds between the page's background refreshes. Defaults to 5. */
  pollSeconds?: number;

  /** Renders the page. The bundled theme when omitted. */
  theme?: DashboardTheme;
}

/** The config with every default applied, built once at provider boot. */
export interface ResolvedWatchtowerConfig {
  storage: "database" | "redis";
  processes: ResolvedProcessConfig[];
  recording: ResolvedRecordingConfig;
  supervisor: Required<WatchtowerSupervisorConfig>;
  /** `undefined` when the `dashboard` key was absent, i.e. no routes. */
  dashboard: ResolvedDashboardConfig | undefined;
}

/**
 * A process with every default applied.
 *
 * `workers` is already reconciled against `fifo` here, so no caller has
 * to remember the interaction.
 */
export interface ResolvedProcessConfig {
  name: string;
  queues: readonly string[];
  workers: number;
  fifo: boolean;
  maxDeferrals: number;
  tries: number | undefined;
  timeout: number | undefined;
  backoff: number | undefined;
  memory: number;
  maxJobs: number | undefined;
  maxTime: number | undefined;
  sleep: number;
}

export interface ResolvedRecordingConfig {
  enabled: boolean;
  queued: boolean;
  queue: string;
  connection: string | undefined;
  retentionDays: number;
}

export interface ResolvedDashboardConfig {
  prefix: string;
  middleware: readonly HttpPipe[];
  pollSeconds: number;
  theme: DashboardTheme | undefined;
}

const DEFAULT_METRICS_QUEUE = "watchtower-metrics";
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MEMORY_MB = 128;
const DEFAULT_SLEEP_SECONDS = 3;
const DEFAULT_MAX_DEFERRALS = 10;
const DEFAULT_DASHBOARD_PREFIX = "/watchtower";
const DEFAULT_POLL_SECONDS = 5;

/**
 * Normalise a config block once, at provider boot.
 *
 * Every default is applied here with `??`, which is both the single
 * place to read them and immune to merge-order surprises: contributing
 * them via `ConfigRepository.merge()` would deep-merge the INCOMING
 * values last and silently overwrite the app's own config rather than
 * layering under it.
 *
 * This normalises only. It does not reject anything — see
 * `validateConfig()`, which is separate so a command can report every
 * problem at once rather than throwing on the first.
 */
export function resolveConfig(config: WatchtowerConfig = {}): ResolvedWatchtowerConfig {
  const recording = config.recording ?? {};
  const supervisor = config.supervisor ?? {};
  const processes = config.processes ?? [{ name: "default", queues: ["default"] }];

  return {
    storage: config.storage ?? "database",
    processes: processes.map(resolveProcess),
    recording: {
      enabled: recording.enabled ?? true,
      queued: recording.queued ?? false,
      queue: recording.queue ?? DEFAULT_METRICS_QUEUE,
      connection: recording.connection,
      retentionDays: recording.retentionDays ?? DEFAULT_RETENTION_DAYS,
    },
    supervisor: {
      shutdownTimeoutSeconds: supervisor.shutdownTimeoutSeconds ?? 30,
      restartBackoffCeilingSeconds: supervisor.restartBackoffCeilingSeconds ?? 60,
      crashLoopThreshold: supervisor.crashLoopThreshold ?? 10,
      crashLoopWindowSeconds: supervisor.crashLoopWindowSeconds ?? 60,
    },
    dashboard: config.dashboard ? resolveDashboard(config.dashboard) : undefined,
  };
}

/**
 * Normalises one process, applying defaults but changing nothing the app
 * asked for.
 *
 * `workers` in particular is left exactly as written even when `fifo` is
 * set, so `validateConfig()` can see the conflict and report it. Clamping
 * here would make the combination unobservable and the error impossible
 * to raise — the caller would get silent single-worker behaviour from a
 * config that says otherwise. The clamp lives at the point of use
 * instead: see `workerCountFor()`.
 */
function resolveProcess(process: WatchtowerProcessConfig): ResolvedProcessConfig {
  const fifo = process.fifo ?? false;

  return {
    name: process.name,
    queues: [...process.queues],
    workers: process.workers ?? 1,
    fifo,
    maxDeferrals: process.maxDeferrals ?? DEFAULT_MAX_DEFERRALS,
    tries: process.tries,
    timeout: process.timeout,
    backoff: process.backoff,
    memory: process.memory ?? DEFAULT_MEMORY_MB,
    maxJobs: process.maxJobs,
    maxTime: process.maxTime,
    sleep: process.sleep ?? DEFAULT_SLEEP_SECONDS,
  };
}

/**
 * How many children the supervisor should actually spawn for a process.
 *
 * `fifo` means one, regardless of what `workers` says. A deferral is
 * process-wide, so several workers do cool down together — but a second
 * worker may already hold the next job when the first defers, which
 * breaks the ordering `fifo` exists to promise.
 *
 * `validateConfig()` rejects the combination outright, so reaching this
 * clamp means validation was skipped. It is the belt to that braces:
 * behaving correctly beats honouring a config that cannot work.
 */
export function workerCountFor(process: ResolvedProcessConfig): number {
  return process.fifo ? 1 : Math.max(1, process.workers);
}

function resolveDashboard(dashboard: WatchtowerDashboardConfig): ResolvedDashboardConfig {
  return {
    prefix: dashboard.prefix ?? DEFAULT_DASHBOARD_PREFIX,
    middleware: [...(dashboard.middleware ?? [])],
    pollSeconds: dashboard.pollSeconds ?? DEFAULT_POLL_SECONDS,
    theme: dashboard.theme,
  };
}
