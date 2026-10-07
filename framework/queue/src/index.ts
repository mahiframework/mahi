export { Job, uniqueModeOf } from "./job.js";
export type { JobClass, UniqueMode, UniqueJobClass } from "./job.js";

export {
  uniqueLockKey,
  resolveUniqueStore,
  acquireUniqueLock,
  releaseUniqueLock,
  DEFAULT_UNIQUE_FOR_SECONDS,
} from "./unique-jobs.js";

export { JobRegistry } from "./job-registry.js";

export { encodeModels, decodeModels } from "./model-serialization.js";
export type { ModelReference } from "./model-serialization.js";

export { encodeJob, decodeJob } from "./job-serialization.js";
export type { JobState } from "./job-serialization.js";

export type { JobMiddleware, JobMiddlewarePassable } from "./middleware/job-middleware.js";
export { ReleaseJobError } from "./middleware/release-job-error.js";
export { runJobThroughMiddleware } from "./middleware/run-job-through-middleware.js";
export { RateLimited } from "./middleware/rate-limited.js";
export { WithoutOverlapping } from "./middleware/without-overlapping.js";
export type { WithoutOverlappingOptions } from "./middleware/without-overlapping.js";
export { ThrottlesExceptions } from "./middleware/throttles-exceptions.js";

export type { QueueDriver, QueuedJob, ChainedJob, PushOptions } from "./queue-driver.js";
export { supportsAfterCommit, supportsClearing } from "./queue-driver.js";
export { SyncQueueDriver } from "./drivers/sync-queue-driver.js";
export { DatabaseQueueDriver } from "./drivers/database-queue-driver.js";
export type { DatabaseQueueDriverOptions } from "./drivers/database-queue-driver.js";
export { FakeQueueDriver } from "./drivers/fake-queue-driver.js";
export type { JobIdentifier, PushedJob } from "./drivers/fake-queue-driver.js";

export { QueueManager } from "./queue-manager.js";
export type { QueueConfig, QueueConnectionConfig, DispatchOptions } from "./queue-manager.js";

export { QueueServiceProvider, QUEUE_TOKEN, JOB_REGISTRY_TOKEN } from "./queue-service-provider.js";

export {
  QueueWorkCommand,
  JobTimeoutError,
  MaxAttemptsExceededError,
} from "./commands/queue-work.js";
// Exported so a subclass overriding `handle()` can type its parameter
// against the real option set rather than widening it.
export type { WorkOptions } from "./commands/queue-work.js";
export { QueueFailedCommand } from "./commands/queue-failed.js";
export { QueueRetryCommand } from "./commands/queue-retry.js";
export { QueueForgetCommand } from "./commands/queue-forget.js";
export { QueueFlushCommand } from "./commands/queue-flush.js";
export { QueueRestartCommand } from "./commands/queue-restart.js";
export { QueueClearCommand } from "./commands/queue-clear.js";

export { QUEUE_RESTART_KEY, restartSignalledAt, signalRestart } from "./restart-signal.js";

export { supportsFailedJobs } from "./failed-job-repository.js";
export type { FailedJobRepository, FailedJobRecord } from "./failed-job-repository.js";

export { JobProcessing, JobProcessed, JobFailed } from "./job-events.js";

export { Bus } from "./bus-facade.js";

export { HandleQueuedListener, QUEUED_LISTENER_JOB } from "./jobs/handle-queued-listener.js";
export { SendQueuedMail, QUEUED_MAIL_JOB } from "./jobs/send-queued-mail.js";

import "./provider-hooks.js";
