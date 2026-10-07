import type { Application } from "@mahiframework/core";
import { DateTime } from "@mahiframework/datetime";
import { WatchtowerJobType } from "./models/watchtower-job-type.model.js";
import { WatchtowerJobRun, type JobRunStatus } from "./models/watchtower-job-run.model.js";

/**
 * One observation about one attempt, as the listener saw it.
 *
 * Plain serializable data, because this travels through a queue when
 * `recording.queued` is on: a `Job`, a `Model` or an `Error` here would
 * either fail to serialize or arrive as something else.
 */
export interface JobRunObservation {
  /** The registered job name, e.g. `"app.jobs.sync-invoice"`. */
  jobName: string;
  /** The constructor name, for display. */
  className: string | null;
  dispatchId: string;
  /** `Invocation.id()` for the attempt being observed, when known. */
  invocationId: string | null;
  process: string | null;
  queue: string | null;
  workerRunId: string | null;
  status: JobRunStatus;
  /** 1-based. The first attempt is 1. */
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
}

/**
 * Writes observations into `watchtower_job_types` / `watchtower_job_runs`.
 *
 * Every write is an UPSERT keyed on `(dispatch_id, attempt)`, never a
 * blind insert, for two independent reasons:
 *
 * A job produces two or three observations as it progresses (running →
 * completed) and they describe the same row.
 *
 * And when `recording.queued` is on they can arrive OUT OF ORDER — the
 * `completed` observation is a separate queue job from the `running` one
 * and nothing sequences them. So a late `running` must not overwrite a
 * `completed` row, which is what `isTerminal()` guards.
 */
export class RunRecorder {
  constructor(private readonly app: Application) {}

  async record(observation: JobRunObservation): Promise<void> {
    const type = await this.upsertType(observation);
    const existing = await WatchtowerJobRun.forAttempt(
      observation.dispatchId,
      observation.attempt,
    ).first();

    if (!existing) {
      await this.insert(type.id, observation);

      return;
    }

    await this.update(existing, observation);
  }

  /**
   * Find or create the job type, bumping `last_seen_at`.
   *
   * A lost race on the unique `name` index is caught and re-read rather
   * than propagated: two workers seeing a job class for the first time
   * simultaneously is normal, and only one insert can win. The loser
   * wants the winner's row, not an error.
   */
  private async upsertType(observation: JobRunObservation): Promise<WatchtowerJobType> {
    const now = DateTime.now();
    const existing = await WatchtowerJobType.findByName(observation.jobName).first();

    if (existing) {
      // `class_name` is backfilled when it was unknown on first sight —
      // a run observed before its class could be resolved records a null
      // and a later successful one fills it in.
      await WatchtowerJobType.query()
        .where("id", existing.id)
        .update({
          last_seen_at: now,
          ...(existing.class_name === null && observation.className !== null
            ? { class_name: observation.className }
            : {}),
        });

      return existing;
    }

    try {
      return (await WatchtowerJobType.create({
        name: observation.jobName,
        class_name: observation.className,
        first_seen_at: now,
        last_seen_at: now,
      })) as WatchtowerJobType;
    } catch (error) {
      const raced = await WatchtowerJobType.findByName(observation.jobName).first();

      if (!raced) {
        throw error;
      }

      return raced;
    }
  }

  private async insert(typeId: string, observation: JobRunObservation): Promise<void> {
    await WatchtowerJobRun.create({
      watchtower_job_type_id: typeId,
      dispatch_id: observation.dispatchId,
      invocation_id: observation.invocationId,
      process: observation.process,
      queue: observation.queue,
      worker_run_id: observation.workerRunId,
      status: observation.status,
      attempt: observation.attempt,
      queued_at: null,
      started_at: toDateTime(observation.startedAt),
      finished_at: toDateTime(observation.finishedAt),
      duration_ms: observation.durationMs,
      error: observation.error,
    });
  }

  /**
   * Merge an observation into an existing row.
   *
   * Two rules, both of which exist because the queued path can deliver
   * observations out of order.
   *
   * **Every field is written only when the observation carries it.** So a
   * late `running` still contributes the `started_at` that a `completed`
   * arriving first could not supply. Writing the observation wholesale
   * would lose whichever half arrived second.
   *
   * **A terminal status is never downgraded.** A late `running` must not
   * reopen a finished run and leave it permanently in progress on the
   * dashboard. Note this guards the STATUS only, not the whole write —
   * skipping the row entirely would discard the timing the late
   * observation is carrying, which is the one thing it knows that the
   * terminal one did not.
   */
  private async update(existing: WatchtowerJobRun, observation: JobRunObservation): Promise<void> {
    const keepStatus = isTerminal(existing.status) && !isTerminal(observation.status);

    await WatchtowerJobRun.query()
      .where("id", existing.id)
      .update({
        ...(keepStatus ? {} : { status: observation.status }),
        ...(observation.invocationId !== null ? { invocation_id: observation.invocationId } : {}),
        ...(observation.process !== null ? { process: observation.process } : {}),
        ...(observation.queue !== null ? { queue: observation.queue } : {}),
        ...(observation.workerRunId !== null ? { worker_run_id: observation.workerRunId } : {}),
        ...(observation.startedAt !== null
          ? { started_at: toDateTime(observation.startedAt) }
          : {}),
        ...(observation.finishedAt !== null
          ? { finished_at: toDateTime(observation.finishedAt) }
          : {}),
        ...(observation.durationMs !== null ? { duration_ms: observation.durationMs } : {}),
        ...(observation.error !== null ? { error: observation.error } : {}),
      });
  }

  /** Delete runs that finished longer ago than `days`, in bounded chunks. */
  async prune(days: number, chunkSize = 1000): Promise<number> {
    const cutoff = DateTime.now().subDays(days);
    let removed = 0;

    // Chunked rather than one statement: this table is the largest in the
    // package by construction, and a single unbounded DELETE on a few
    // million rows holds locks long enough to stall the workers writing
    // into it.
    for (;;) {
      const ids = (
        await WatchtowerJobRun.query().where("finished_at", "<", cutoff).limit(chunkSize).get()
      )
        .all()
        .map((run) => run.id);

      if (ids.length === 0) {
        break;
      }

      await WatchtowerJobRun.query().whereIn("id", ids).delete();
      removed += ids.length;
    }

    return removed;
  }
}

/**
 * A status no later observation may move away from.
 *
 * `released` counts: the attempt ended, and the retry is a separate row
 * with its own attempt number. Treating it as non-terminal would let a
 * stale `running` reopen it.
 */
export function isTerminal(status: JobRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "released";
}

function toDateTime(value: string | null): DateTime | null {
  return value === null ? null : DateTime.parse(value);
}
