import { Command } from "@mahiframework/cli";
import type { CommanderCommand } from "@mahiframework/cli";
import {
  formatCount,
  formatDuration,
  formatRate,
  formatRelative,
  formatThroughput,
} from "../dashboard/format.js";
import { WATCHTOWER_TOKEN } from "../tokens.js";
import type { WatchtowerManager } from "../watchtower-manager.js";

/**
 * Throughput and reliability per job type, over a rolling window.
 *
 * The question this answers is "which job is the problem", which the
 * queue's own CLI cannot: `queue:failed` lists individual failures, so a
 * job failing 2% of the time at high volume looks the same as one failing
 * every time at low volume. Aggregates distinguish them.
 */
export class WatchtowerListCommand extends Command {
  signature = "watchtower:list";
  description = "Show throughput, failure rate and durations per job type.";

  configure(program: CommanderCommand): void {
    program.option("--hours <n>", "Rolling window to aggregate over", "24");
    program.option("--job <name>", "Drill into one job type's recent attempts");
  }

  async handle(options: { hours?: string; job?: string } = {}): Promise<void> {
    const watchtower = this.app.make<WatchtowerManager>(WATCHTOWER_TOKEN);
    const hours = Number(options.hours ?? 24);

    if (!Number.isFinite(hours) || hours <= 0) {
      this.error(`--hours must be a positive number, got "${options.hours}".`);
      process.exitCode = 1;

      return;
    }

    if (options.job !== undefined) {
      await this.detail(watchtower, options.job, hours);

      return;
    }

    const types = await watchtower.jobTypes(hours);

    if (types.length === 0) {
      this.info("No jobs have run yet.");

      return;
    }

    this.table(
      ["Job type", "Done", "Failed", "Rate", "p50", "p95", "Throughput", "Last seen"],
      types.map((type) => [
        type.className ?? type.name,
        formatCount(type.completedCount),
        formatCount(type.failedCount),
        formatRate(type.failureRate),
        formatDuration(type.p50DurationMs),
        formatDuration(type.p95DurationMs),
        formatThroughput(type.throughputPerMinute),
        formatRelative(type.lastSeenAt),
      ]),
    );
  }

  /**
   * One job type's attempts, grouped by dispatch.
   *
   * Grouped because that is the story: three rows under one dispatch id
   * is "failed twice then succeeded", which reads as one event. Three
   * ungrouped failures read as three problems.
   */
  private async detail(watchtower: WatchtowerManager, name: string, hours: number): Promise<void> {
    const detail = await watchtower.jobType(name, hours);

    if (!detail) {
      this.error(`No job type named "${name}" has been seen.`);
      process.exitCode = 1;

      return;
    }

    this.info(
      `${detail.className ?? detail.name} — ` +
        `${formatCount(detail.completedCount)} done, ` +
        `${formatCount(detail.failedCount)} failed (${formatRate(detail.failureRate)}), ` +
        `p50 ${formatDuration(detail.p50DurationMs)}, p95 ${formatDuration(detail.p95DurationMs)}`,
    );
    this.line("");

    for (const chain of detail.attemptChains) {
      this.line(`dispatch ${chain.dispatchId}`);

      this.table(
        ["Attempt", "Status", "Duration", "When", "Invocation"],
        chain.attempts.map((run) => [
          String(run.attempt),
          run.status,
          formatDuration(run.durationMs),
          formatRelative(run.finishedAt ?? run.startedAt),
          run.invocationId ?? "-",
        ]),
      );

      this.line("");
    }
  }
}
