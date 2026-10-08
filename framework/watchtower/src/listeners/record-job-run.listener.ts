import { Invocation, QUEUE_TOKEN, type Application } from "@mahiframework/core";
import { DateTime } from "@mahiframework/datetime";
import type { Listener } from "@mahiframework/events";
import {
  JobFailed,
  JobProcessed,
  JobProcessing,
  JobReleased,
  QUEUED_LISTENER_JOB,
  QUEUED_MAIL_JOB,
  type QueueManager,
  type QueuedJob,
} from "@mahiframework/queue";
import { isWatchtowerJob } from "../drivers/watchtower-queue-driver.js";
import { RECORD_JOB_RUN_JOB, RecordJobRunJob } from "../jobs/record-job-run.job.js";
import { RunRecorder, type JobRunObservation } from "../run-recorder.js";
import type { JobRunStatus } from "../models/watchtower-job-run.model.js";
import { WATCHTOWER_TOKEN } from "../tokens.js";
import type { WatchtowerManager } from "../watchtower-manager.js";

/** Any of the queue lifecycle events. */
type LifecycleEvent = JobProcessing | JobProcessed | JobFailed | JobReleased;

/**
 * Job names that are never recorded, regardless of configuration.
 *
 * `RECORD_JOB_RUN_JOB` is the recursion guard and the reason this list
 * exists: running it fires its own `JobProcessing`/`JobProcessed`, which
 * this listener would observe by dispatching another one, forever. The
 * same hard exclusion `ActivityLog` needs for the same reason — without
 * it "one mutation would recurse until the stack blew".
 *
 * The other two are framework plumbing. A queued listener or a queued
 * mail send is not work an operator thinks of as a job, and recording
 * them makes the dashboard's job-type list mostly noise.
 *
 * Not configurable. A flag here would be a footgun with no legitimate
 * setting.
 */
const NEVER_RECORDED: ReadonlySet<string> = new Set([
  RECORD_JOB_RUN_JOB,
  QUEUED_LISTENER_JOB,
  QUEUED_MAIL_JOB,
]);

/**
 * Turns queue lifecycle events into run-history rows.
 *
 * Subscribed to the three event classes rather than driving the history
 * from the driver, deliberately: the events are already dispatched by the
 * worker on EVERY driver, so an app on the plain `database` connection
 * gets the whole history by registering this provider and nothing else.
 * That is the more valuable half of the package and should not require
 * adopting the supervisor.
 *
 * ## Errors are swallowed
 *
 * The worker already dispatches these defensively — "a listener that
 * itself throws must not derail the worker" — but relying on that would
 * mean an error here surfaces as an unexplained log line from the queue
 * package. Caught and logged with context instead. Observability must
 * never be able to fail the thing it observes.
 *
 * ## Timing
 *
 * A job's start time is held in memory, keyed by `(dispatchId, attempt)`,
 * because nothing in the event payload carries it: `JobProcessed` knows
 * the job finished but not when it began. The map is bounded — an entry
 * is deleted the moment its terminal event arrives, and a worker that
 * dies loses only its own in-flight entries along with the process.
 */
export class RecordJobRunListener implements Listener<LifecycleEvent> {
  private readonly startedAt = new Map<string, number>();

  constructor(private readonly app: Application) {}

  async handle(event: LifecycleEvent): Promise<void> {
    try {
      await this.record(event);
    } catch (error) {
      this.app.logger.error("watchtower: failed to record a job run.", {
        job: event.queued.jobClass,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async record(event: LifecycleEvent): Promise<void> {
    if (NEVER_RECORDED.has(event.queued.jobClass)) {
      return;
    }

    const manager = this.app.make<WatchtowerManager>(WATCHTOWER_TOKEN);
    const recording = manager.configuration().recording;

    if (!recording.enabled) {
      return;
    }

    const observation = this.observe(event);

    if (recording.queued) {
      // Dispatched explicitly rather than through `listenQueued()`,
      // because the handler that machinery installs dispatches with NO
      // options — so every queued listener in the app lands on the
      // default connection's default queue. Metrics sharing a queue with
      // real work means a backed-up queue also blinds the dashboard that
      // would have shown you it was backed up.
      await this.app.make<QueueManager>(QUEUE_TOKEN).dispatch(new RecordJobRunJob(observation), {
        queue: recording.queue,
        ...(recording.connection !== undefined ? { connection: recording.connection } : {}),
      });

      return;
    }

    await new RunRecorder(this.app).record(observation);
  }

  /**
   * Build the observation, reading the invocation id of the attempt being
   * observed.
   *
   * `Invocation.current()`, never `Invocation.id()`. `id()` GENERATES one
   * on demand, and on the queued path this listener may run outside the
   * observed job's scope — so `id()` would mint an id belonging to
   * something else and record it as if it were the job's. A wrong value
   * is worse than a missing one, and `current()` returns `null` instead.
   */
  private observe(event: LifecycleEvent): JobRunObservation {
    const queued = event.queued;
    const key = attemptKey(queued);
    const attempt = queued.attempts + 1;
    const status = statusFor(event);
    const now = Date.now();

    let startedAt: number | undefined;

    if (event instanceof JobProcessing) {
      this.startedAt.set(key, now);
      startedAt = now;
    } else {
      startedAt = this.startedAt.get(key);
      // Bounded: the entry goes the moment the attempt ends, whichever
      // way it ended.
      this.startedAt.delete(key);
    }

    // Anything but `JobProcessing` ends the attempt, a release included:
    // the retry is a separate attempt with its own row, so this one is
    // over and needs a `finished_at` or it reads as still running.
    const finished = event instanceof JobProcessing ? null : now;

    return {
      jobName: queued.jobClass,
      className: (event.job as { constructor?: { name?: string } }).constructor?.name ?? null,
      dispatchId: dispatchIdOf(queued),
      invocationId: Invocation.current(),
      process: processName(this.app),
      queue: queued.queue ?? null,
      workerRunId: workerRunId(this.app),
      status,
      attempt,
      startedAt: startedAt === undefined ? null : iso(startedAt),
      finishedAt: finished === null ? null : iso(finished),
      durationMs: finished !== null && startedAt !== undefined ? finished - startedAt : null,
      error: event instanceof JobFailed ? (event.error.stack ?? event.error.message) : null,
    };
  }
}

function statusFor(event: LifecycleEvent): JobRunStatus {
  if (event instanceof JobProcessed) {
    return "completed";
  }

  if (event instanceof JobFailed) {
    return "failed";
  }

  if (event instanceof JobReleased) {
    return "released";
  }

  return "running";
}

/**
 * The dispatch id for a job, which MUST be identical for every
 * observation of the same work.
 *
 * On this package's driver it is a real column, carried through release,
 * fail and retry. On any other driver there is no such column, so it is
 * DERIVED from the queue row's id — deterministically, because minting a
 * fresh UUID per observation would give the `running` and `completed`
 * events different ids and produce two rows for one attempt instead of
 * upserting onto one.
 *
 * The derived form is namespaced so it cannot collide with a real
 * UUIDv7, and it is honest about its weakness: a driver that re-inserts
 * on retry (both core drivers do) changes the row id, so a retried job's
 * attempts will NOT chain on those drivers. The history is still correct
 * per attempt, just not grouped. Only Watchtower's own driver can group
 * them, which is one of the reasons it exists.
 */
function dispatchIdOf(queued: QueuedJob): string {
  return isWatchtowerJob(queued) ? queued.dispatchId : `row:${String(queued.id)}`;
}

/**
 * The in-memory key for an attempt's start time.
 *
 * `(dispatchId, attempts)` rather than the row id alone, so two attempts
 * at one job do not share a timer.
 */
function attemptKey(queued: QueuedJob): string {
  return `${dispatchIdOf(queued)}:${queued.attempts}`;
}

/**
 * Which supervised process is running, read from the environment.
 *
 * The worker child publishes it, so an inline recording from a
 * `watchtower:worker` is attributed and one from a bare `queue:work` or a
 * `Bus.dispatch()` is honestly null rather than guessed.
 */
function processName(app: Application): string | null {
  void app;

  return process.env.MAHI_WATCHTOWER_PROCESS ?? null;
}

function workerRunId(app: Application): string | null {
  void app;

  return process.env.MAHI_WATCHTOWER_RUN_ID ?? null;
}

/** Seconds-precision ISO, matching what the timestamp columns can hold. */
function iso(epochMs: number): string {
  return DateTime.fromTimestamp(epochMs).toISOString();
}
