import type { Command as CommanderCommand } from "commander";
import { Command } from "@mahiframework/cli";
import { DB, Relation } from "@mahiframework/database";
import type { MediaManager } from "../media-manager.js";
import { mediaModels } from "../models/registry.js";
import { mediaReferences } from "../references.js";
import { MEDIA_TOKEN } from "../tokens.js";

/** How many rows or files one invocation will remove before stopping. */
const DEFAULT_LIMIT = 10_000;

/**
 * Delete media nothing refers to any more, and files with no row.
 *
 * THREE KINDS OF ORPHAN, because there are three ways to make one.
 *
 * An orphaned OWNED ROW is one whose `model_type`/`model_id` names a
 * record that no longer exists. Nothing in the framework cascades
 * deletes into this table — `media.model_id` carries no foreign key,
 * because it holds the key of any model and the app owns those tables —
 * so deleting a `Post` leaves its media behind. That is the right trade
 * (a foreign key here would mean this package naming the app's tables)
 * and this command is the other half of it.
 *
 * An orphaned REFERENCED ROW is a `belongsToMedia` row — both morph
 * columns null, the foreign key on the owner's own table — that no
 * registered reference column points at any more. Neither of the other
 * two sweeps can see it: it survives the owned sweep for recording no
 * owner, and its file survives the file sweep because the row still
 * exists and so its path is still known. Answering "is this row
 * referenced" means querying tables this package does not own, which is
 * what `registerMediaReference()` supplies.
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
  description = "Delete media rows nothing refers to, and files with no row.";

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
    await this.pruneUnreferencedRows(limit, dryRun);

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

    await this.deleteRows(doomed);

    this.app.logger.info(`media:prune deleted ${doomed.length} orphaned row(s) and their files.`);
  }

  /**
   * Delete `belongsToMedia` rows that no registered reference points at.
   *
   * The morph columns are null for these rows by design — the owner
   * holds the key — so `pruneRows()` filters them out before it looks
   * for an owner, and must: treating "no owner recorded" as "owner gone"
   * would delete every avatar in the application. The file sweep cannot
   * reach them either, because the row exists and so its path is known.
   * This is the only sweep that can.
   *
   * 🚨 WITH NO REFERENCES REGISTERED, THIS DOES NOTHING. The degenerate
   * query — "referenced by none of zero tables" — selects every
   * null-morph row in the table, which is every avatar in the
   * application. An app that has not called `registerMediaReference()`,
   * or a command that loaded fewer providers than the app does, gets a
   * no-op and a log line saying why. Same stance as `pruneRows()` on an
   * unresolvable `model_type`, and for the same reason.
   *
   * A row referenced from two registered columns is kept by either, so a
   * deliberately shared row — one stored file, many records — survives.
   */
  private async pruneUnreferencedRows(limit: number, dryRun: boolean): Promise<void> {
    const candidates = (
      await mediaModels.media.query().whereNull("model_type").whereNull("model_id").get()
    ).all();

    if (candidates.length === 0) {
      return;
    }

    const references = mediaReferences();

    if (references.length === 0) {
      this.app.logger.info(
        `media:prune skipped its reference sweep: ${candidates.length} row(s) record no owner ` +
          `(the belongsToMedia case), and no reference columns are registered, so whether ` +
          `anything still points at them cannot be known. Call registerMediaReference({ ` +
          `table: "users", column: "avatar_id" }) from the owning model's provider.`,
      );

      return;
    }

    const referenced = new Set<string>();

    for (const reference of references) {
      const rows = await DB.table<Record<string, unknown>>(reference.table, reference.connection)
        .select(reference.column)
        .whereNotNull(reference.column)
        .get();

      for (const row of rows) {
        const key = row[reference.column];

        if (key !== null && key !== undefined && key !== "") {
          referenced.add(String(key));
        }
      }
    }

    const doomed = candidates
      .filter((row) => !referenced.has(String(row.id)))
      .slice(0, limit)
      .map((row) => row.id);

    if (doomed.length === 0) {
      this.app.logger.info("media:prune found no unreferenced rows.");

      return;
    }

    if (dryRun) {
      this.app.logger.info(`media:prune would delete ${doomed.length} unreferenced row(s).`);

      return;
    }

    await this.deleteRows(doomed);

    this.app.logger.info(
      `media:prune deleted ${doomed.length} unreferenced row(s) and their files.`,
    );
  }

  /**
   * Delete media rows by id, one at a time through the model.
   *
   * Per row, not a bulk `whereIn().delete()`, so each row's `deleting`
   * hook runs and deletes its file. The bulk form would be one statement
   * and would leave every file behind.
   */
  private async deleteRows(ids: readonly bigint[]): Promise<void> {
    for (const id of ids) {
      const row = await mediaModels.media.find(id);

      await row?.deleteInstance();
    }
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
