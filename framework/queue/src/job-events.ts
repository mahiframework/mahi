import { AbstractEvent } from "@mahiframework/events";
import type { Job } from "./job.js";
import type { QueuedJob } from "./queue-driver.js";

/**
 * Queue lifecycle events, dispatched by the `queue:work` worker through
 * `@mahiframework/events` (when an `EventsServiceProvider` is registered) so
 * app code, error reporting, a monitoring page, metrics, can react to
 * job progress without editing the worker. Analogous to Laravel's
 * `JobProcessing`/`JobProcessed`/`JobFailed`.
 *
 * Each carries the connection name, the rebuilt live `Job` instance, and
 * the raw `QueuedJob` record (id, attempts, jobClass). `JobFailed` also
 * carries the error that exhausted the job.
 *
 * Every started attempt reaches exactly ONE terminal event:
 * `JobProcessed`, `JobFailed` or `JobReleased`. A consumer may rely on
 * that, which is the whole reason `JobReleased` exists: without it a
 * released attempt announced its start and then went quiet, so anything
 * pairing the events (run history, a metric, an in-flight gauge) counted
 * it as still running forever.
 *
 * Fire-and-forget: a listener that itself throws must not derail the
 * worker, so the worker dispatches these defensively (see `queue-work.ts`).
 */
export class JobProcessing extends AbstractEvent {
  constructor(
    public readonly connection: string | undefined,
    public readonly job: Job,
    public readonly queued: QueuedJob,
  ) {
    super();
  }
}

export class JobProcessed extends AbstractEvent {
  constructor(
    public readonly connection: string | undefined,
    public readonly job: Job,
    public readonly queued: QueuedJob,
  ) {
    super();
  }
}

export class JobFailed extends AbstractEvent {
  constructor(
    public readonly connection: string | undefined,
    public readonly job: Job,
    public readonly queued: QueuedJob,
    public readonly error: Error,
  ) {
    super();
  }
}

/**
 * An attempt ended by being put back on the queue rather than by
 * succeeding or failing: a rate limiter was hit, a lock was held, or the
 * job threw `ReleaseJobError` itself because the work simply could not
 * run yet.
 *
 * Terminal for the ATTEMPT, not for the job. The retry is a separate
 * attempt with its own `JobProcessing`, so a consumer should close the
 * current attempt here and expect another to open later, which is
 * exactly how a failed-then-retried attempt already behaves.
 *
 * `delaySeconds` is how long the driver was asked to withhold it. On a
 * FIFO process that delay also pauses the whole process, so the figure
 * is worth surfacing: it is the difference between "retrying shortly"
 * and "this queue is stalled".
 */
export class JobReleased extends AbstractEvent {
  constructor(
    public readonly connection: string | undefined,
    public readonly job: Job,
    public readonly queued: QueuedJob,
    public readonly delaySeconds: number,
  ) {
    super();
  }
}
