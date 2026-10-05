import type { Command as CommanderCommand } from "commander";
import { Command } from "@mahiframework/cli";
import { Relation } from "@mahiframework/database";
import type { MediaManager } from "../media-manager.js";
import { mediaModels } from "../models/registry.js";
import { MEDIA_TOKEN } from "../tokens.js";

/** How many rows or files one invocation will remove before stopping. */
const DEFAULT_LIMIT = 10_000;

/**
 * Delete media whose owner is gone, and files with no row.
 *
 * TWO KINDS OF ORPHAN, because there are two ways to make one.
 *
 * An orphaned ROW is one whose `model_type`/`model_id` names a record
 * that no longer exists. Nothing in the framework cascades deletes into
 * this table — `media.model_id` carries no foreign key, because it holds
 * the key of any model and the app owns those tables — so deleting a
 * `Post` leaves its media behind. That is the right trade (a foreign key
 * here would mean this package naming the app's tables) and this command
 * is the other half of it.
 *
 * An orphaned FILE is bytes on a disk with no row pointing at them. The
 * upload path writes the file before inserting the row, deliberately: a
 * row with no file is unrepairable, while a file with no row is merely
 * wasted space. This reclaims it.
 *
 * NOT SCHEDULED AUTOMATICALLY. Deleting a user's uploads is not a
 * decision a package should make on a timer, and the file sweep lists an
 * entire disk — which on an object store costs real money. Run it from
 * the app's own schedule, with `--dry-run` first.
 */
export class MediaPruneCommand extends Command {
  signature = "media:prune";
  description = "Delete media rows whose owner is gone, and files with no row.";

  configure(program: CommanderCommand): void {
    program.option("--files", "Also sweep files on the disk with no media row", false);
    program.option("--disk <disk>", "Which disk to sweep for orphaned files");
    program.option("--limit <rows>", "Maximum rows or files to delete", String(DEFAULT_LIMIT));
    program.option("--dry-run", "Report what would be deleted, delete nothing", false);
  }

  async handle(
    options: { files?: boolean; disk?: string; limit?: string; dryRun?: boolean } = {},
  ): Promise<void> {
    const limit = Number(options.limit ?? DEFAULT_LIMIT);

    if (!Number.isFinite(limit) || limit <= 0) {
      this.app.logger.error("media:prune needs a positive --limit.");
      process.exitCode = 1;

      return;
    }

    const dryRun = options.dryRun === true;

    await this.pruneRows(limit, dryRun);

    if (options.files === true) {
      await this.pruneFiles(options.disk, limit, dryRun);
    }
  }

  /**
   * Delete rows whose owner no longer exists.
   *
   * Grouped by `model_type` so each owning table is queried once rather
   * than once per media row. A type that resolves to no registered model
   * is SKIPPED, not deleted: the morph map is populated by providers,
   * and a command that loaded fewer of them than the app does would
   * otherwise delete every row belonging to a model it simply could not
   * see.
   */
  private async pruneRows(limit: number, dryRun: boolean): Promise<void> {
    const owned = await mediaModels.media
      .query()
      .whereNotNull("model_type")
      .whereNotNull("model_id")
      .get();

    const byType = new Map<string, { id: bigint; modelId: string }[]>();

    for (const row of owned.all()) {
      if (row.model_type === null || row.model_id === null) {
        continue;
      }

      const group = byType.get(row.model_type) ?? [];

      group.push({ id: row.id, modelId: row.model_id });
      byType.set(row.model_type, group);
    }

    const doomed: bigint[] = [];
    const skipped: string[] = [];

    for (const [type, rows] of byType) {
      const owner = Relation.getMorphedModel(type);

      if (owner === undefined) {
        skipped.push(type);

        continue;
      }

      const keys = [...new Set(rows.map((row) => row.modelId))];
      const alive = new Set(
        (await owner.query().whereIn(owner.primaryKeyColumn, keys).get())
          .all()
          .map((record) => String(record.getKey())),
      );

      for (const row of rows) {
        if (!alive.has(row.modelId) && doomed.length < limit) {
          doomed.push(row.id);
        }
      }
    }

    for (const type of skipped) {
      this.app.logger.info(
        `media:prune skipped "${type}": it matches no registered model, so whether its ` +
          `owners still exist cannot be known. Register the model's provider, or check ` +
          `Relation.morphMap().`,
      );
    }

    if (doomed.length === 0) {
      this.app.logger.info("media:prune found no orphaned rows.");

      return;
    }

    if (dryRun) {
      this.app.logger.info(`media:prune would delete ${doomed.length} orphaned row(s).`);

      return;
    }

    // One at a time, through the model, so each row's `deleting` hook
    // runs and deletes its file. A bulk `whereIn().delete()` would be
    // one statement and would leave every file behind.
    for (const id of doomed) {
      const row = await mediaModels.media.find(id);

      await row?.deleteInstance();
    }

    this.app.logger.info(`media:prune deleted ${doomed.length} orphaned row(s) and their files.`);
  }

  /**
   * Delete files on the disk that no row points at.
   *
   * Lists the whole disk, which is why this is behind `--files`: on an
   * object store that is a paid API call per thousand keys, and on a
   * large disk it is slow.
   *
   * Only ONE disk per run, and only files under the configured path
   * prefix, so a disk shared with anything else is not swept wholesale.
   */
  private async pruneFiles(
    disk: string | undefined,
    limit: number,
    dryRun: boolean,
  ): Promise<void> {
    const manager = this.app.make<MediaManager>(MEDIA_TOKEN);
    const name = manager.diskName(disk ?? null);
    const driver = manager.disk(name);
    const prefix = manager.config.path ?? undefined;

    const onDisk = await driver.allFiles(prefix);

    if (onDisk.length === 0) {
      this.app.logger.info("media:prune found no files on the disk.");

      return;
    }

    // Every path this disk's rows claim. A row with a null `disk`
    // follows the default, so it counts for the default disk's sweep.
    const known = new Set((await mediaModels.media.query().get()).all().map((row) => row.path));

    const orphans = onDisk.filter((path) => !known.has(path)).slice(0, limit);

    if (orphans.length === 0) {
      this.app.logger.info("media:prune found no orphaned files.");

      return;
    }

    if (dryRun) {
      this.app.logger.info(
        `media:prune would delete ${orphans.length} orphaned file(s) from "${name ?? "the default disk"}".`,
      );

      return;
    }

    for (const path of orphans) {
      await driver.delete(path);
    }

    this.app.logger.info(
      `media:prune deleted ${orphans.length} orphaned file(s) from "${name ?? "the default disk"}".`,
    );
  }
}
