import { Command } from "@mahiframework/cli";
import { formatAge, formatCount } from "../dashboard/format.js";
import { WATCHTOWER_TOKEN } from "../tokens.js";
import type { WatchtowerManager } from "../watchtower-manager.js";

/**
 * What every process and queue is doing right now.
 *
 * Reads the same `Watchtower.stats()` the dashboard does, so the two can
 * never disagree — and so a terminal is a complete substitute for the
 * dashboard rather than a degraded one.
 *
 * Static table output rather than a live-refreshing view. The TUI's
 * frame-diffing renderer exists but is not exported, is bottom-pinned and
 * single-region, and there is no SIGWINCH handling anywhere — so a resize
 * would not redraw. Honest static output beats a half-working live view.
 */
export class WatchtowerStatusCommand extends Command {
  signature = "watchtower:status";
  description = "Show watchtower process states and queue depths.";

  async handle(): Promise<void> {
    const stats = await this.app.make<WatchtowerManager>(WATCHTOWER_TOKEN).stats();

    if (stats.paused) {
      this.warn("Every watchtower process is paused.");
    }

    for (const warning of stats.warnings) {
      this.warn(warning);
    }

    this.line("");
    this.info(
      `Pending ${formatCount(stats.totals.pending)}  ` +
        `Running ${formatCount(stats.totals.reserved)}  ` +
        `Failed/hr ${formatCount(stats.totals.failedLastHour)}  ` +
        `Done/hr ${formatCount(stats.totals.completedLastHour)}  ` +
        `Oldest ${formatAge(stats.totals.oldestPendingSeconds)}`,
    );
    this.line("");

    this.table(
      ["Process", "Queues", "Workers", "State", "Detail"],
      stats.processes.map((process) => [
        process.name + (process.fifo ? " (fifo)" : ""),
        process.queues.join(" › "),
        `${process.workersAlive}/${process.workersConfigured}`,
        process.state,
        process.deferredUntil === null ? "" : `until ${process.deferredUntil}`,
      ]),
    );

    this.line("");

    this.table(
      ["Queue", "Pending", "Oldest", "Claimed by"],
      stats.queues.map((queue) => [
        queue.queue,
        formatCount(queue.pending),
        formatAge(queue.oldestPendingSeconds),
        queue.claimedBy ?? "unclaimed",
      ]),
    );

    if (stats.recentFailures.length === 0) {
      return;
    }

    this.line("");
    this.table(
      ["Failed job", "Attempt", "Process", "Invocation"],
      stats.recentFailures.map((run) => [
        run.jobType,
        String(run.attempt),
        run.process ?? "-",
        // The id that joins this failure to the application's own log
        // lines, which is the first thing an operator wants to paste
        // into their aggregator.
        run.invocationId ?? "-",
      ]),
    );
  }
}
