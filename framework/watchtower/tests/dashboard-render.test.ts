import { afterEach, describe, expect, it } from "vitest";
import { QUEUE_TOKEN } from "@mahiframework/core";
import type { QueueManager } from "@mahiframework/queue";
import { Watchtower } from "../src/watchtower-facade.js";
import { WatchtowerServiceProvider } from "../src/watchtower-service-provider.js";
import { WatchtowerQueueDriver } from "../src/drivers/watchtower-queue-driver.js";
import { RunRecorder, type JobRunObservation } from "../src/run-recorder.js";
import {
  buildFailed,
  buildJobType,
  buildOverview,
  type DashboardUrls,
} from "../src/dashboard/build-page.js";
import { DefaultDashboardTheme } from "../src/dashboard/default-dashboard-theme.js";
import { WATCHTOWER_CONNECTION } from "../src/tokens.js";
import { createHarness, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

afterEach(() => {
  harness?.cleanup();
});

const urls: DashboardUrls = {
  overview: "/watchtower",
  failed: "/watchtower?view=failed",
  data: "/watchtower/data",
  jobType: (name) => `/watchtower?view=job&job=${encodeURIComponent(name)}`,
  retry: (id) => `/watchtower/retry/${id}`,
};

const theme = new DefaultDashboardTheme();

async function boot(config: Record<string, unknown> = {}): Promise<Harness> {
  harness = await createHarness();
  harness.app.config.set("watchtower", { dashboard: {}, ...config });
  harness.app.register(WatchtowerServiceProvider);
  await harness.app.bootstrap();

  return harness;
}

let seq = 0;

function observation(overrides: Partial<JobRunObservation> = {}): JobRunObservation {
  seq += 1;

  return {
    jobName: "app.jobs.sync-invoice",
    className: "SyncInvoiceJob",
    dispatchId: `018f0000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    invocationId: "018f0000-0000-7000-8000-00000000cafe",
    process: "default",
    queue: "default",
    workerRunId: null,
    status: "completed",
    attempt: 1,
    startedAt: nowIso(),
    finishedAt: nowIso(),
    durationMs: 842,
    error: null,
    ...overrides,
  };
}

/**
 * The whole pipeline against real data: migrations, driver, recorder,
 * reader, page builder, theme. A unit test of any one layer would miss a
 * shape mismatch between two of them.
 */
describe("dashboard render", () => {
  it("renders an overview for an empty system", async () => {
    await boot();

    const html = theme.render(buildOverview(await Watchtower.stats(), urls, 5));

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Queue health");
    // Empty states rather than blank sections, so a new install does not
    // look broken.
    expect(html).toContain("No jobs have run yet.");
    expect(html).toContain("Nothing has failed in this window.");
  });

  it("renders queue depth and job aggregates", async () => {
    await boot({ processes: [{ name: "default", queues: ["default"] }] });

    const driver = harness.app
      .make<QueueManager>(QUEUE_TOKEN)
      .connection(WATCHTOWER_CONNECTION) as WatchtowerQueueDriver;

    await driver.push("app.jobs.sync-invoice", {});
    await driver.push("app.jobs.sync-invoice", {});

    const recorder = new RunRecorder(harness.app);
    await recorder.record(observation({ status: "completed" }));
    await recorder.record(observation({ status: "failed", error: "Error: boom" }));

    const html = theme.render(buildOverview(await Watchtower.stats(), urls, 5));

    expect(html).toContain("SyncInvoiceJob");
    expect(html).toContain("50.0%");
    // Formatted, not raw: the IR carries milliseconds and the formatter
    // is the only thing that turns them into something readable.
    expect(html).toContain("842ms");
  });

  it("renders a sparkline for a job type that has completed something", async () => {
    await boot();

    const recorder = new RunRecorder(harness.app);
    await recorder.record(observation({ status: "completed" }));

    const html = theme.render(buildOverview(await Watchtower.stats(), urls, 5));

    // The whole point of the series: it reaches the markup from recorded
    // runs, rather than only from a hand-built IR in a theme test.
    expect(html).toContain('class="spark"');
    // Normalised against the type's own peak, so its busiest bucket is
    // always full height.
    expect(html).toContain('style="height:100%"');
  });

  it("omits the sparkline for a job type that has completed nothing", async () => {
    await boot();

    await new RunRecorder(harness.app).record(observation({ status: "failed", error: "boom" }));

    const html = theme.render(buildOverview(await Watchtower.stats(), urls, 5));

    // Eight zero-height bars read as a rendering failure, and the
    // throughput figure beside it already says zero.
    expect(html).toContain("SyncInvoiceJob");
    expect(html).not.toContain('class="spark"');
  });

  it("warns unmissably when a process has no live workers", async () => {
    await boot({ processes: [{ name: "xero", queues: ["xero"], workers: 2 }] });

    const html = theme.render(buildOverview(await Watchtower.stats(), urls, 5));

    // Work has silently stopped, which is the most severe thing that can
    // appear on this page.
    expect(html).toContain("alert severe");
    expect(html).toContain("xero has no live workers");
  });

  it("renders a failure's trace escaped, inside a pre", async () => {
    await boot();

    await new RunRecorder(harness.app).record(
      observation({
        status: "failed",
        error: "Error: Invalid email: <script>alert(1)</script>\n    at Foo.bar (a.ts:1:1)",
      }),
    );

    const stats = await Watchtower.stats();
    const html = theme.render(buildFailed(stats, await Watchtower.recentFailures(), urls, 5));

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<pre>");
  });

  it("offers a retry on the failed list but not the overview", async () => {
    await boot();

    await new RunRecorder(harness.app).record(
      observation({ status: "failed", error: "Error: boom" }),
    );

    const stats = await Watchtower.stats();
    const overview = theme.render(buildOverview(stats, urls, 5));
    const failed = theme.render(buildFailed(stats, await Watchtower.recentFailures(), urls, 5));

    // A retry is easy to click by accident, and the overview is the page
    // left open on a monitor.
    expect(overview).not.toContain("Retry job");
    expect(failed).toContain("Retry job");
    expect(failed).toContain('method="post"');
  });

  it("renders a job type's attempt chain", async () => {
    await boot();
    const recorder = new RunRecorder(harness.app);
    const dispatchId = "018f0000-0000-7000-8000-0000000000ff";

    await recorder.record(observation({ dispatchId, attempt: 1, status: "failed", error: "x" }));
    await recorder.record(observation({ dispatchId, attempt: 2, status: "completed" }));

    const detail = await Watchtower.jobType("app.jobs.sync-invoice");
    const html = theme.render(buildJobType(await Watchtower.stats(), detail!, urls, 5));

    expect(html).toContain("Dispatch history");
    expect(html).toContain("2 attempts");
    // The id that joins an attempt to the app's own log lines, with a
    // copy button — the primary debugging affordance.
    expect(html).toContain("data-watchtower-copy");
  });

  it("renders sections alone for the poll, without the document shell", async () => {
    await boot();

    const page = buildOverview(await Watchtower.stats(), urls, 5);
    const sections = theme.renderSections(page);

    // The poll replaces one container: re-sending `<head>` and the
    // script would be waste at best and a duplicated listener at worst.
    expect(sections).not.toContain("<!doctype html>");
    expect(sections).not.toContain("<script");
    expect(sections).not.toContain("<style");
    expect(sections).toContain('class="metrics"');
  });

  it("loads nothing over the network, with real data in it", async () => {
    await boot();

    await new RunRecorder(harness.app).record(
      observation({ status: "failed", error: "Error: boom" }),
    );

    const html = theme.render(buildOverview(await Watchtower.stats(), urls, 5));

    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toContain("<link");
    expect(html).not.toMatch(/https?:\/\//);
  });
});

function nowIso(): string {
  return new Date().toISOString().slice(0, 19) + "Z";
}
