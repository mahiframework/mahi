import type { Command as CommanderCommand } from "commander";
import { Command } from "@mahiframework/cli";
import { Relation } from "@mahiframework/database";
import { MediaChecksumMismatchError } from "../errors.js";
import type { MediaManager } from "../media-manager.js";
import { mediaModels } from "../models/registry.js";
import { MEDIA_TOKEN } from "../tokens.js";

/**
 * Check that every media row still describes a file that is there.
 *
 * Three kinds of rot, all silent until something tries to serve a file:
 *
 * A MISSING FILE is a row whose bytes are gone — deleted out of band, or
 * lost when a disk was migrated. Nothing notices until a user clicks the
 * link.
 *
 * An UNRESOLVABLE OWNER is a `model_type` that matches no registered
 * model. `morphAlias()` falls back to the TABLE NAME, so renaming a
 * table orphans every row naming the old one, and media rows outlive
 * table renames. `permissions:check` exists for the same reason.
 *
 * A CHECKSUM MISMATCH (under `--verify`) is a file whose bytes changed
 * underneath the row. Off by default because it reads every byte of
 * every file.
 *
 * Exits non-zero so CI or a monitor can gate on it.
 */
export class MediaCheckCommand extends Command {
  signature = "media:check";
  description = "Verify that media rows, their files and their owners all still exist.";

  configure(program: CommanderCommand): void {
    program.option("--verify", "Also re-hash every file and compare its checksum", false);
    program.option("--limit <rows>", "Only check this many rows");
  }

  async handle(options: { verify?: boolean; limit?: string } = {}): Promise<void> {
    const manager = this.app.make<MediaManager>(MEDIA_TOKEN);
    const limit = options.limit === undefined ? undefined : Number(options.limit);

    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
      this.app.logger.error("media:check needs a positive --limit.");
      process.exitCode = 1;

      return;
    }

    const query = mediaModels.media.query().orderBy("created_at", "asc");
    const rows = (await (limit === undefined ? query : query.limit(limit)).get()).all();

    if (rows.length === 0) {
      this.app.logger.info("media:check: there are no media rows to check.");

      return;
    }

    const missing: string[] = [];
    const unresolvable = new Map<string, number>();
    const corrupt: string[] = [];

    for (const row of rows) {
      if (!(await manager.disk(row.disk).exists(row.path))) {
        missing.push(`${row.id} (${row.original_filename}) at ${row.path}`);

        // No point hashing a file that is not there.
        continue;
      }

      if (options.verify === true) {
        try {
          await row.verify();
        } catch (error) {
          if (error instanceof MediaChecksumMismatchError) {
            corrupt.push(`${row.id} (${row.original_filename})`);
          } else {
            throw error;
          }
        }
      }
    }

    // Owners are checked by type rather than per row: one lookup per
    // distinct `model_type` instead of one per media row.
    for (const type of new Set(rows.map((row) => row.model_type))) {
      if (type === null) {
        continue;
      }

      if (Relation.getMorphedModel(type) === undefined) {
        unresolvable.set(type, (unresolvable.get(type) ?? 0) + 1);
      }
    }

    for (const entry of missing) {
      this.app.logger.error(`media:check: the file for media ${entry} is missing.`);
    }

    for (const entry of corrupt) {
      this.app.logger.error(
        `media:check: media ${entry} does not match its recorded checksum. The file has ` +
          `been modified or replaced out of band.`,
      );
    }

    for (const [type] of unresolvable) {
      this.app.logger.error(
        `media:check: "${type}" matches no registered model. Morph aliases come from a ` +
          `Relation.morphMap() entry, a model's \`static morphName\`, or its table name — ` +
          `so a renamed table orphans every row naming the old one.`,
      );
    }

    const problems = missing.length + corrupt.length + unresolvable.size;

    if (problems === 0) {
      this.app.logger.info(
        `media:check: ${rows.length} row(s) checked, all present` +
          `${options.verify === true ? " and verified" : ""}.`,
      );

      return;
    }

    this.app.logger.error(`media:check found ${problems} problem(s) across ${rows.length} row(s).`);
    process.exitCode = 1;
  }
}
