import type { Command as CommanderCommand } from "commander";
import { Command } from "@mahiframework/cli";
import { DateTime } from "@mahiframework/datetime";
import { ActivityLog } from "../models/activity-log.model.js";

/** How many rows one invocation will delete before stopping. */
const DEFAULT_LIMIT = 100_000;

/**
 * Delete activity rows older than a cutoff.
 *
 * The table grows without bound and nothing else deletes from it, so
 * retention is a policy the application has to choose. Not scheduled
 * automatically: a retention window is a compliance decision, and a
 * package that silently discarded audit history after 90 days because
 * nobody configured otherwise would be making that decision for you.
 *
 * Capped per run rather than deleting the whole matching set in one
 * statement. The first prune on a table that has never been pruned can
 * match tens of millions of rows, and a single unbounded `DELETE` holds
 * a long transaction and a lot of locks. Running it twice is cheap.
 */
export class ActivityLogsPruneCommand extends Command {
  signature = "activity-logs:prune";
  description = "Delete activity log rows older than the retention window.";

  configure(program: CommanderCommand): void {
    program.option("--days <days>", "Delete rows older than this many days", "90");
    program.option("--type <type>", "Only prune rows of this type");
    program.option("--limit <rows>", "Maximum rows to delete in one run", String(DEFAULT_LIMIT));
    program.option("--dry-run", "Report what would be deleted, delete nothing", false);
  }

  async handle(
    options: { days?: string; type?: string; limit?: string; dryRun?: boolean } = {},
  ): Promise<void> {
    const days = Number(options.days ?? 90);
    const limit = Number(options.limit ?? DEFAULT_LIMIT);

    if (!Number.isFinite(days) || days < 0) {
      this.app.logger.error("activity-logs:prune needs a non-negative --days.");

      return;
    }

    const cutoff = DateTime.now().subDays(days);
    const matching = await this.scope(cutoff, options.type).count();

    if (options.dryRun === true) {
      this.app.logger.info(
        `activity-logs:prune would delete ${matching} row(s) older than ${cutoff.toISOString()}.`,
      );

      return;
    }

    // Select the ids first, then delete by key. A bare `.limit().delete()`
    // is not portable: MySQL supports `DELETE ... LIMIT`, Postgres does
    // not, and this package has to work on both.
    const doomed = (await this.scope(cutoff, options.type).limit(limit).get())
      .all()
      .map((row) => row.id);

    if (doomed.length === 0) {
      this.app.logger.info("activity-logs:prune found nothing to delete.");

      return;
    }

    const deleted = await ActivityLog.query().whereIn("id", doomed).delete();

    this.app.logger.info(
      `activity-logs:prune deleted ${deleted} of ${matching} row(s) older than ${cutoff.toISOString()}.`,
    );

    if (matching > deleted) {
      this.app.logger.info(
        `activity-logs:prune stopped at the --limit of ${limit}; run it again to continue.`,
      );
    }
  }

  private scope(cutoff: DateTime, type: string | undefined) {
    const query = ActivityLog.query().where("created_at", "<", cutoff);

    return type === undefined ? query : query.where("type", type);
  }
}
