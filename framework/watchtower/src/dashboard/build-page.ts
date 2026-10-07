import type {
  JobRunSummary,
  JobTypeDetail,
  ProcessStatus,
  QueueDepth,
  WatchtowerStats,
} from "../stats.js";
import {
  formatAge,
  formatCount,
  formatDuration,
  formatRate,
  formatRelative,
  formatThroughput,
} from "./format.js";
import type {
  DashboardFailure,
  DashboardPage,
  DashboardSection,
  TableSection,
} from "./dashboard-page.js";

/** Where the dashboard's own routes live, so links can be built. */
export interface DashboardUrls {
  overview: string;
  failed: string;
  data: string;
  /** Given a job type name, its detail page. */
  jobType: (name: string) => string;
  /** Given a run id, where a retry POSTs. */
  retry: (runId: string) => string;
}

/**
 * Turns `WatchtowerStats` into the page a theme renders.
 *
 * This is where presentation decisions live — which thresholds colour a
 * cell, how a duration reads, what order sections appear in — and
 * deliberately NOT in the theme, which only maps data to markup, nor in
 * the reader, which only queries. That split is what lets an app replace
 * the theme without re-deriving any of this, and replace this without
 * touching either.
 */
export function buildOverview(
  stats: WatchtowerStats,
  urls: DashboardUrls,
  pollSeconds: number,
): DashboardPage {
  const sections: DashboardSection[] = [];

  if (stats.paused) {
    sections.push({
      kind: "alert",
      severity: "warn",
      title: "Every process is paused",
      detail: "Workers are up and polling, but nothing is being reserved.",
    });
  }

  // Crash-looping (reported as `stopped` with workers configured) is the
  // most severe thing that can appear here, because work has silently
  // stopped. It goes first and unmissably.
  for (const process of stats.processes) {
    if (process.state === "stopped" && process.workersConfigured > 0) {
      sections.push({
        kind: "alert",
        severity: "danger",
        title: `${process.name} has no live workers`,
        detail:
          `${process.workersConfigured} worker(s) are configured but none is reporting, so ` +
          `${process.queues.join(", ")} is not being drained.`,
      });
    }
  }

  for (const warning of stats.warnings) {
    sections.push({
      kind: "alert",
      severity: "warn",
      title: "Configuration warning",
      detail: warning,
    });
  }

  sections.push({
    kind: "metrics",
    metrics: [
      {
        label: "Pending",
        value: formatCount(stats.totals.pending),
        meta: `across ${stats.queues.length} queue(s)`,
      },
      {
        label: "Running",
        value: formatCount(stats.totals.reserved),
        meta: "currently being worked",
      },
      {
        label: "Failed · last hour",
        value: formatCount(stats.totals.failedLastHour),
        severity: stats.totals.failedLastHour > 0 ? "danger" : "ok",
      },
      {
        label: "Completed · last hour",
        value: formatCount(stats.totals.completedLastHour),
      },
      {
        label: "Oldest pending",
        value: formatAge(stats.totals.oldestPendingSeconds),
        meta: oldestQueueName(stats.queues) ?? "nothing waiting",
        severity: worstQueueSeverity(stats.queues),
      },
    ],
  });

  sections.push({
    kind: "columns",
    left: processTable(stats.processes),
    right: queueTable(stats.queues),
  });

  sections.push(jobTypeTable(stats, urls));

  sections.push({
    kind: "failures",
    eyebrow: "RECENT FAILURES",
    heading: "What broke",
    note: `${stats.recentFailures.length} shown · newest first`,
    failures: stats.recentFailures.map((run) => toFailure(run, urls, false)),
    emptyText: "Nothing has failed in this window.",
  });

  return {
    title: "Queue health",
    eyebrow: "SUPERVISOR / OVERVIEW",
    subtitle: "Is the queue healthy, what is stuck, what broke.",
    active: "overview",
    nav: navFor(stats, urls),
    sections,
    footer: `generated at ${stats.generatedAt}`,
    pollSeconds,
    dataUrl: urls.data,
  };
}

/** The failed-jobs list, with retry buttons and expandable traces. */
export function buildFailed(
  stats: WatchtowerStats,
  failures: JobRunSummary[],
  urls: DashboardUrls,
  pollSeconds: number,
): DashboardPage {
  return {
    title: "Failed jobs",
    eyebrow: "FAILURES",
    subtitle: "One row per failed attempt. Retry is the only mutating action.",
    active: "failed",
    nav: navFor(stats, urls),
    sections: [
      {
        kind: "failures",
        eyebrow: "FAILED JOB RUNS",
        heading: "Recent failures",
        note: `${failures.length} shown · newest first`,
        failures: failures.map((run) => toFailure(run, urls, true)),
        emptyText: "No failures recorded.",
      },
    ],
    footer: `generated at ${stats.generatedAt}`,
    pollSeconds,
    dataUrl: `${urls.data}?view=failed`,
  };
}

/** One job type: its aggregates, its attempt chains, its recent runs. */
export function buildJobType(
  stats: WatchtowerStats,
  detail: JobTypeDetail,
  urls: DashboardUrls,
  pollSeconds: number,
): DashboardPage {
  return {
    title: detail.className ?? detail.name,
    eyebrow: "JOB TYPE / DETAIL",
    subtitle: detail.name,
    active: "job",
    backTo: { label: "Overview", url: urls.overview },
    nav: navFor(stats, urls),
    sections: [
      {
        kind: "metrics",
        metrics: [
          { label: "Completed", value: formatCount(detail.completedCount) },
          {
            label: "Failed",
            value: formatCount(detail.failedCount),
            meta: `${formatRate(detail.failureRate)} failure rate`,
            severity: detail.severity,
          },
          {
            label: "p50 duration",
            value: formatDuration(detail.p50DurationMs),
            meta: "median attempt",
          },
          {
            label: "p95 duration",
            value: formatDuration(detail.p95DurationMs),
            meta: "slowest 5%",
          },
          {
            label: "Throughput",
            value: formatThroughput(detail.throughputPerMinute),
            meta: "rolling average",
          },
        ],
      },
      {
        kind: "chains",
        eyebrow: "ATTEMPT CHAINS",
        heading: "Dispatch history",
        note: "attempts grouped by dispatchId",
        chains: detail.attemptChains.map((chain) => ({
          dispatchId: chain.dispatchId,
          attempts: chain.attempts.map((run) => ({
            status: run.status,
            severity: run.status === "failed" ? ("danger" as const) : ("ok" as const),
            attempt: run.attempt,
            when: formatRelative(run.finishedAt ?? run.startedAt),
            duration: formatDuration(run.durationMs),
            invocationId: run.invocationId,
          })),
        })),
        emptyText: "This job type has not run in the current window.",
      },
      {
        kind: "failures",
        eyebrow: "RECENT RUNS",
        heading: "Every attempt",
        note: `last ${detail.recentRuns.length}`,
        failures: detail.recentRuns
          .filter((run) => run.status === "failed")
          .map((run) => toFailure(run, urls, true)),
        emptyText: "No failed attempts in this window.",
      },
    ],
    footer: `generated at ${stats.generatedAt}`,
    pollSeconds,
    dataUrl: `${urls.data}?view=job&job=${encodeURIComponent(detail.name)}`,
  };
}

function navFor(stats: WatchtowerStats, urls: DashboardUrls) {
  return {
    overviewUrl: urls.overview,
    failedUrl: urls.failed,
    failedCount: stats.totals.failedLastHour,
  };
}

function processTable(processes: ProcessStatus[]): TableSection {
  return {
    kind: "table",
    eyebrow: "PROCESS STATUS",
    heading: "Workers",
    note: `${processes.length} process(es)`,
    columns: ["Process", "Workers", "State", "Processed"],
    rows: processes.map((process) => ({
      cells: [
        { text: process.name, sub: process.queues.join("  ›  ") },
        {
          text: `${process.workersAlive}/${process.workersConfigured}`,
          // A fifo process is deliberately single-worker, so `1/1` next
          // to this tag should read as correct rather than
          // under-provisioned.
          ...(process.fifo ? { tag: "FIFO" } : {}),
        },
        {
          text: process.state,
          severity: process.severity,
          ...(process.deferredUntil === null ? {} : { sub: `until ${process.deferredUntil}` }),
        },
        { text: formatCount(process.processed) },
      ],
    })),
    emptyText: "No processes are configured.",
  };
}

function queueTable(queues: QueueDepth[]): TableSection {
  return {
    kind: "table",
    eyebrow: "QUEUE DEPTH",
    heading: "What is waiting",
    note: "pending jobs",
    columns: ["Queue", "Pending", "Oldest", "Claimed by"],
    rows: queues.map((queue) => ({
      cells: [
        { text: queue.queue },
        { text: formatCount(queue.pending) },
        { text: formatAge(queue.oldestPendingSeconds), severity: queue.severity },
        // An unclaimed queue is silent and serious: jobs pushed there
        // are never worked.
        queue.claimedBy === null
          ? { text: "unclaimed", severity: "danger" as const }
          : { text: queue.claimedBy },
      ],
    })),
    emptyText: "No queues are configured.",
  };
}

function jobTypeTable(stats: WatchtowerStats, urls: DashboardUrls): TableSection {
  return {
    kind: "table",
    eyebrow: "JOB TYPES · ROLLING WINDOW",
    heading: "Throughput & reliability",
    columns: ["Job type", "Done", "Failed", "Rate", "p50 / p95", "Throughput"],
    rows: stats.jobTypes.map((type) => ({
      url: urls.jobType(type.name),
      cells: [
        { text: type.className ?? type.name, sub: type.name },
        { text: formatCount(type.completedCount) },
        { text: formatCount(type.failedCount) },
        { text: formatRate(type.failureRate), severity: type.severity },
        {
          text: `${formatDuration(type.p50DurationMs)} / ${formatDuration(type.p95DurationMs)}`,
        },
        { text: formatThroughput(type.throughputPerMinute) },
      ],
    })),
    emptyText: "No jobs have run yet.",
  };
}

/**
 * A run as a failure row.
 *
 * `retryUrl` is withheld on the overview: a retry from a summary view is
 * easy to click by accident and the overview is the page an operator
 * leaves open. The full list and the detail view offer it.
 */
function toFailure(run: JobRunSummary, urls: DashboardUrls, retryable: boolean): DashboardFailure {
  return {
    jobLabel: run.className ?? run.jobType,
    jobUrl: urls.jobType(run.jobType),
    attempt: run.attempt,
    when: formatRelative(run.finishedAt ?? run.startedAt),
    process: run.process,
    queue: run.queue,
    dispatchId: run.dispatchId,
    invocationId: run.invocationId,
    trace: run.error,
    ...(retryable ? { retryUrl: urls.retry(run.id) } : {}),
  };
}

function oldestQueueName(queues: QueueDepth[]): string | null {
  let worst: QueueDepth | null = null;

  for (const queue of queues) {
    if (queue.oldestPendingSeconds === null) {
      continue;
    }

    if (worst === null || queue.oldestPendingSeconds > (worst.oldestPendingSeconds ?? 0)) {
      worst = queue;
    }
  }

  return worst?.queue ?? null;
}

function worstQueueSeverity(queues: QueueDepth[]): "ok" | "warn" | "danger" {
  if (queues.some((queue) => queue.severity === "danger")) {
    return "danger";
  }

  return queues.some((queue) => queue.severity === "warn") ? "warn" : "ok";
}
