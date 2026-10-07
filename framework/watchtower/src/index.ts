export { WatchtowerManager } from "./watchtower-manager.js";
export type { WatchtowerGate } from "./watchtower-manager.js";

export { Watchtower } from "./watchtower-facade.js";

export { WatchtowerServiceProvider, WATCHTOWER_TOKEN } from "./watchtower-service-provider.js";
export { WATCHTOWER_CONNECTION } from "./tokens.js";

export { WatchtowerJobType } from "./models/watchtower-job-type.model.js";
export type { WatchtowerJobTypeAttributes } from "./models/watchtower-job-type.model.js";
export { WatchtowerJobRun } from "./models/watchtower-job-run.model.js";
export type {
  WatchtowerJobRunAttributes,
  JobRunStatus,
} from "./models/watchtower-job-run.model.js";

export { resolveConfig, workerCountFor } from "./watchtower-config.js";
export type {
  WatchtowerConfig,
  WatchtowerProcessConfig,
  WatchtowerRecordingConfig,
  WatchtowerSupervisorConfig,
  WatchtowerDashboardConfig,
  ResolvedWatchtowerConfig,
  ResolvedProcessConfig,
  ResolvedRecordingConfig,
  ResolvedDashboardConfig,
} from "./watchtower-config.js";

export { DefaultDashboardTheme } from "./dashboard/default-dashboard-theme.js";
export { DASHBOARD_STYLES } from "./dashboard/styles.js";
export type { DashboardTheme } from "./dashboard/dashboard-theme.js";
export type {
  DashboardPage,
  DashboardSection,
  DashboardNav,
  DashboardLink,
  AlertSection,
  MetricStripSection,
  DashboardMetric,
  TableSection,
  DashboardRow,
  DashboardCell,
  ColumnsSection,
  FailureListSection,
  DashboardFailure,
  ChainListSection,
  DashboardChain,
  DashboardChainAttempt,
  EmptySection,
} from "./dashboard/dashboard-page.js";
export { buildOverview, buildFailed, buildJobType } from "./dashboard/build-page.js";
export type { DashboardUrls } from "./dashboard/build-page.js";
export { DashboardController } from "./http/dashboard.controller.js";

// `validateConfig` is exported for `watchtower:check`, which reports
// warnings too; `configErrors` is the provider's boot-time subset and has
// no caller outside it.
export { validateConfig } from "./validate-config.js";
export type { ConfigProblem } from "./validate-config.js";

export {
  WatchtowerError,
  WatchtowerConfigError,
  DeferralUnsupportedError,
  GateAlreadyRegisteredError,
  UnknownProcessError,
} from "./errors.js";

// The deferral/pause key helpers are exported because the worker and the
// supervisor live in this package but a test (or an app diagnosing a
// stuck process) legitimately needs to read the same keys.
export {
  DeferralStore,
  deferralKey,
  pauseKey,
  heartbeatKey,
  isSharedStore,
  GLOBAL_PAUSE_KEY,
} from "./deferral.js";
export type { WaitState, WorkerHeartbeat } from "./deferral.js";

export {
  WatchtowerQueueDriver,
  isWatchtowerJob,
  supportsDeferral,
} from "./drivers/watchtower-queue-driver.js";
export type {
  WatchtowerQueueDriverOptions,
  WatchtowerQueuedJob,
  DeferrableQueueDriver,
} from "./drivers/watchtower-queue-driver.js";

export { RunRecorder, isTerminal } from "./run-recorder.js";
export type { JobRunObservation } from "./run-recorder.js";
export { RecordJobRunListener } from "./listeners/record-job-run.listener.js";
export { RecordJobRunJob, RECORD_JOB_RUN_JOB } from "./jobs/record-job-run.job.js";

export { watchtowerGate } from "./http/gate.js";

export { WatchtowerCheckCommand } from "./commands/watchtower-check.js";
export { WatchtowerPauseCommand } from "./commands/watchtower-pause.js";
export { WatchtowerUnpauseCommand } from "./commands/watchtower-unpause.js";
export { WatchtowerRestartCommand } from "./commands/watchtower-restart.js";
export { WatchtowerPruneCommand } from "./commands/watchtower-prune.js";

export { StatsReader } from "./stats-reader.js";
export { severityForAge, severityForFailureRate, severityForState } from "./stats.js";
export type {
  Severity,
  WatchtowerStats,
  WatchtowerTotals,
  ProcessStatus,
  ProcessState,
  QueueDepth,
  JobTypeSummary,
  JobRunSummary,
  AttemptChain,
  JobTypeDetail,
} from "./stats.js";

export { WatchtowerStatusCommand } from "./commands/watchtower-status.js";
export { WatchtowerListCommand } from "./commands/watchtower-list.js";
export {
  formatAge,
  formatDuration,
  formatCount,
  formatRate,
  formatThroughput,
  formatRelative,
  summariseTrace,
} from "./dashboard/format.js";
