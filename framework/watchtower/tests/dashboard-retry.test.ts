import { afterEach, describe, expect, it } from "vitest";
import { QUEUE_TOKEN } from "@mahiframework/core";
import { HttpError } from "@mahiframework/http";
import type { Request } from "@mahiframework/http";
import { DashboardController } from "../src/http/dashboard.controller.js";
import { WatchtowerQueueDriver } from "../src/drivers/watchtower-queue-driver.js";
import type { WatchtowerQueuedJob } from "../src/drivers/watchtower-queue-driver.js";
import { RunRecorder } from "../src/run-recorder.js";
import { WatchtowerJobRun } from "../src/models/watchtower-job-run.model.js";
import { WATCHTOWER_CONNECTION } from "../src/tokens.js";
import { createHarness, captureError, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

afterEach(() => {
  harness?.cleanup();
});

/** A request carrying one route parameter, which is all `retry()` reads. */
function request(run: unknown): Request {
  return { route: () => run } as unknown as Request;
}

/**
 * The retry endpoint is the dashboard's ONLY mutating action, and the one
 * place where the package's two id spaces meet: the page lists run
 * history (`watchtower_job_runs.id`) while the queue keys failures off
 * `watchtower_failed_jobs.id`. Those ids are unrelated, so the endpoint
 * has to translate through the `dispatch_id` both tables carry — handing
 * the run id straight to the driver matches nothing and every retry
 * 404s, with the button appearing to do nothing at all.
 */
describe("DashboardController.retry", () => {
  async function boot(): Promise<{ driver: WatchtowerQueueDriver }> {
    harness = await createHarness();
    harness.app.config.set("watchtower", { dashboard: {} });

    const driver = new WatchtowerQueueDriver(harness.database.driver().kysely, {
      connectionName: WATCHTOWER_CONNECTION,
    });
    harness.queue.extend(WATCHTOWER_CONNECTION, () => driver);
    harness.app.instance(QUEUE_TOKEN, harness.queue);

    return { driver };
  }

  /** Fail a job and record the run history row the dashboard would show. */
  async function failOne(driver: WatchtowerQueueDriver): Promise<{ runId: string }> {
    await driver.push("app.jobs.sync", { invoiceId: 3 }, { queue: "alpha" });
    const job = (await driver.pop("alpha")) as WatchtowerQueuedJob;
    await driver.fail(job, new Error("boom"));

    await new RunRecorder(harness.app).record({
      jobName: "app.jobs.sync",
      className: "SyncJob",
      dispatchId: job.dispatchId,
      invocationId: null,
      process: null,
      queue: "alpha",
      workerRunId: null,
      status: "failed",
      attempt: 1,
      startedAt: "2026-10-07T12:00:00Z",
      finishedAt: "2026-10-07T12:00:01Z",
      durationMs: 1000,
      error: "Error: boom",
    });

    const run = await WatchtowerJobRun.query().first();

    return { runId: String(run?.id) };
  }

  it("retries the failure the listed run belongs to", async () => {
    const { driver } = await boot();
    const { runId } = await failOne(driver);

    const response = await new DashboardController(harness.app).retry(request(runId));

    expect(response.getStatus()).toBe(200);
    // Actually requeued, not merely reported as such.
    expect(await driver.listFailed()).toHaveLength(0);
    expect((await driver.pop("alpha"))?.jobClass).toBe("app.jobs.sync");
  });

  it("404s for a run id that does not exist", async () => {
    await boot();

    const error = await captureError(
      new DashboardController(harness.app).retry(request("018f0000-0000-7000-8000-00000000dead")),
    );

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(404);
  });

  it("404s when the route parameter is missing", async () => {
    await boot();

    const error = await captureError(
      new DashboardController(harness.app).retry(request(undefined)),
    );

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(404);
  });

  /**
   * The run exists but its failure has already been retried or pruned,
   * so there is nothing left to requeue. Reported, not thrown.
   */
  it("reports a run whose failed job is already gone", async () => {
    const { driver } = await boot();
    const { runId } = await failOne(driver);

    await new DashboardController(harness.app).retry(request(runId));
    const response = await new DashboardController(harness.app).retry(request(runId));

    expect(response.getStatus()).toBe(404);
  });
});
