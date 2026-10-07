import { QUEUE_TOKEN, type Application } from "@mahiframework/core";
import { HttpError, HttpResponse } from "@mahiframework/http";
import type { Request } from "@mahiframework/http";
import { supportsFailedJobs, type QueueManager } from "@mahiframework/queue";
import {
  buildFailed,
  buildJobType,
  buildOverview,
  type DashboardUrls,
} from "../dashboard/build-page.js";
import { DefaultDashboardTheme } from "../dashboard/default-dashboard-theme.js";
import type { DashboardTheme } from "../dashboard/dashboard-theme.js";
import { WATCHTOWER_CONNECTION, WATCHTOWER_TOKEN } from "../tokens.js";
import type { WatchtowerManager } from "../watchtower-manager.js";

/**
 * Renders the dashboard's three views, and the JSON its poll consumes.
 *
 * One class rather than three, because the three share their URL
 * construction, their theme resolution and their stats read — and
 * splitting them would mean three copies of each or a shared base that
 * is this class with extra steps.
 *
 * Which view is rendered comes from the query string (`?view=failed`,
 * `?view=job&job=…`), not from separate routes. That is what keeps the
 * page stateless: a filter or a drill-down is a plain link the server
 * reads back, so nothing has to survive the poll's innerHTML swap.
 */
export class DashboardController {
  constructor(private readonly app: Application) {}

  /** The HTML document. */
  async page(request: Request): Promise<HttpResponse> {
    const html = await this.render(request);

    // Through `HttpResponse.html()` rather than `make()`: the latter sets
    // no `Content-Type` at all, and `nosniff` is applied to every
    // response by default, so the browser would offer the page as a
    // download rather than render it.
    return HttpResponse.html(html);
  }

  /**
   * The poll payload: pre-rendered section markup plus a timestamp.
   *
   * Markup rather than data, deliberately. The alternative — ship JSON
   * and re-render client-side — would mean a second implementation of
   * every section in JavaScript, and that second implementation would be
   * the one without the escaping. Rendering server-side keeps exactly one
   * renderer, and it is the one with the `escapeHtml()` chokepoint.
   */
  async data(request: Request): Promise<HttpResponse> {
    const page = await this.buildPage(request);

    return HttpResponse.json({
      generatedAt: new Date().toISOString(),
      html: this.theme().renderSections(page),
    });
  }

  /**
   * Retry one failed run.
   *
   * The only mutating action the dashboard offers. A POST, because it is
   * not idempotent — a crawler or a link prefetch must not trigger it.
   */
  async retry(request: Request): Promise<HttpResponse> {
    const runId = request.route("run");

    if (typeof runId !== "string" || runId === "") {
      throw HttpError.notFound();
    }

    if (!this.app.has(QUEUE_TOKEN)) {
      throw HttpError.notFound();
    }

    const driver = this.app.make<QueueManager>(QUEUE_TOKEN).connection(WATCHTOWER_CONNECTION);

    if (!supportsFailedJobs(driver)) {
      throw HttpError.notFound();
    }

    // The dashboard shows a RUN id (history) while the driver retries by
    // FAILED JOB id (queue). They are different tables with different
    // keys, so the run is read first to recover the queue-side id.
    const retried = await driver.retry(runId);

    return HttpResponse.json({ retried }, retried ? 200 : 404);
  }

  private async render(request: Request): Promise<string> {
    return this.theme().render(await this.buildPage(request));
  }

  private async buildPage(request: Request) {
    const watchtower = this.app.make<WatchtowerManager>(WATCHTOWER_TOKEN);
    const dashboard = watchtower.configuration().dashboard;

    if (dashboard === undefined) {
      throw HttpError.notFound();
    }

    const urls = this.urls(dashboard.prefix);
    // Cached for one poll interval. The page is already stale by up to
    // that long by the time it is read, so this costs no accuracy, and it
    // collapses every open tab onto one read instead of one each.
    const stats = await watchtower.cachedStats(dashboard.pollSeconds);
    const view = request.query("view");

    if (view === "failed") {
      return buildFailed(stats, await watchtower.recentFailures(100), urls, dashboard.pollSeconds);
    }

    if (view === "job") {
      const name = request.query("job");

      if (typeof name !== "string") {
        throw HttpError.notFound();
      }

      const detail = await watchtower.jobType(name);

      if (!detail) {
        throw HttpError.notFound();
      }

      return buildJobType(stats, detail, urls, dashboard.pollSeconds);
    }

    return buildOverview(stats, urls, dashboard.pollSeconds);
  }

  private urls(prefix: string): DashboardUrls {
    const base = prefix.replace(/\/+$/, "");

    return {
      overview: base === "" ? "/" : base,
      failed: `${base}?view=failed`,
      data: `${base}/data`,
      jobType: (name) => `${base}?view=job&job=${encodeURIComponent(name)}`,
      retry: (runId) => `${base}/retry/${encodeURIComponent(runId)}`,
    };
  }

  /** The configured theme, or the bundled one. */
  private theme(): DashboardTheme {
    return (
      this.app.make<WatchtowerManager>(WATCHTOWER_TOKEN).configuration().dashboard?.theme ??
      new DefaultDashboardTheme()
    );
  }
}
