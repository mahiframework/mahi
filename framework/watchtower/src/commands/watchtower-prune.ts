import { Command } from "@mahiframework/cli";
import type { CommanderCommand } from "@mahiframework/cli";
import { RunRecorder } from "../run-recorder.js";
import { WATCHTOWER_TOKEN } from "../tokens.js";
import type { WatchtowerManager } from "../watchtower-manager.js";

/**
 * Trim `watchtower_job_runs` to the configured retention.
 *
 * Not optional maintenance. The table grows by one row per job per
 * attempt, so a busy app accumulates millions and the queries the
 * dashboard runs over it get slower in proportion. Schedule it:
 *
 *   schedule.command("watchtower:prune").daily();
 *
 * Guarded with `confirmToProceed()`, not `confirm()`. A prompt with no
 * TTY resolves to its default rather than blocking, so an unattended
 * production run would delete history silently and exit 0. The guard
 * fails closed instead and sets a non-zero exit code, so a pipeline that
 * forgot `--force` fails rather than reporting success for work that
 * never happened.
 */
export class WatchtowerPruneCommand extends Command {
  signature = "watchtower:prune";
  description = "Delete watchtower run history older than the configured retention.";

  configure(program: CommanderCommand): void {
    program.option("--days <n>", "Override the configured retention, in days");
    program.option("--chunk <n>", "Rows to delete per statement", "1000");
    program.option("--force", "Skip the production confirmation");
  }

  async handle(options: { days?: string; chunk?: string; force?: boolean } = {}): Promise<void> {
    const watchtower = this.app.make<WatchtowerManager>(WATCHTOWER_TOKEN);
    const configured = watchtower.configuration().recording.retentionDays;

    const days = options.days === undefined ? configured : Number(options.days);
    const chunk = Number(options.chunk ?? 1000);

    // Validated BEFORE the confirmation, so a typo'd `--days` fails fast
    // rather than prompting for a run that was never going to work.
    if (!Number.isFinite(days) || days < 0) {
      this.error(`--days must be a non-negative number, got "${options.days}".`);
      process.exitCode = 1;

      return;
    }

    if (!Number.isFinite(chunk) || chunk <= 0) {
      this.error(`--chunk must be a positive number, got "${options.chunk}".`);
      process.exitCode = 1;

      return;
    }

    if (!(await this.confirmToProceed(options))) {
      return;
    }

    const removed = await new RunRecorder(this.app).prune(days, chunk);

    this.info(
      removed === 0
        ? `No run history older than ${days} day(s).`
        : `Pruned ${removed} run(s) older than ${days} day(s).`,
    );
  }
}
