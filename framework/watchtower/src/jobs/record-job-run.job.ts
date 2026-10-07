import { app } from "@mahiframework/core";
import { Job } from "@mahiframework/queue";
import { RunRecorder, type JobRunObservation } from "../run-recorder.js";

/**
 * Writes one run observation, off the worker's hot path.
 *
 * Dispatched by `RecordJobRunListener` when `recording.queued` is on.
 * Not intended to be dispatched by application code.
 *
 * The observation is carried as a constructor field of plain data, so it
 * survives the same serialize/rebuild round trip as any other job's
 * fields. Nothing live (a `Job`, a `Model`, an `Error`) can travel here.
 */
export class RecordJobRunJob extends Job {
  constructor(public readonly observation: JobRunObservation) {
    super();
  }

  async handle(): Promise<void> {
    await new RunRecorder(app()).record(this.observation);
  }
}

/**
 * The registry name this job is dispatched under.
 *
 * `RecordJobRunListener` hard-excludes it, unconditionally: running this
 * job fires its own `JobProcessing`/`JobProcessed`, which the listener
 * would observe and record by dispatching another one of these, forever.
 */
export const RECORD_JOB_RUN_JOB = "watchtower.record-job-run";
