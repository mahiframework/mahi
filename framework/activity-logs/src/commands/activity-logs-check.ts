import { Command } from "@mahiframework/cli";
import { Relation } from "@mahiframework/database";
import { ActivityLogger } from "../activity-logger.js";
import { ActivityLog } from "../models/activity-log.model.js";
import { ACTIVITY_LOG_TOKEN } from "../tokens.js";

/**
 * Validate the `activity-logs` config against the models that exist.
 *
 * This command is the price of keying `resources` by morph alias instead
 * of by class. A string key cannot be typo-checked by the compiler, so
 * `Posts: "full"` silently configures nothing while `Post` keeps
 * capturing nothing — a hole that looks exactly like working config.
 *
 * It is a CHECK, not a boot failure. A model can legitimately be
 * registered by a provider this command never loads, so an unmatched key
 * is reported rather than fatal at runtime. Exits non-zero so CI can gate
 * on it.
 */
export class ActivityLogsCheckCommand extends Command {
  signature = "activity-logs:check";
  description = "Validate activity-logs configuration against registered models.";

  async handle(): Promise<void> {
    const logger = this.app.make<ActivityLogger>(ACTIVITY_LOG_TOKEN);
    const config = logger.settings;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (config.resources.size === 0) {
      this.app.logger.info(
        "activity-logs:check: no resources are configured, so no model writes are recorded.",
      );
    }

    for (const [alias, resource] of config.resources) {
      if (alias === ActivityLog.morphAlias()) {
        errors.push(
          `"${alias}" is this package's own table. Logging it would recurse on every write; ` +
            `the listener ignores it regardless, so remove the entry.`,
        );

        continue;
      }

      const model = Relation.getMorphedModel(alias);

      if (model === undefined) {
        errors.push(
          `"${alias}" matches no registered model. Morph aliases come from a Relation.morphMap() ` +
            `entry, a static morphName, or the table name; check the spelling and that the ` +
            `model's provider is registered.`,
        );

        continue;
      }

      // The closest available substitute for the encrypted-cast check the
      // package cannot do: there is no encrypted cast in the framework, so
      // a "full" capture on a model that declares nothing sensitive is the
      // only signal that secrets may be getting written.
      const declares =
        (model.hidden?.length ?? 0) > 0 ||
        (model.visible?.length ?? 0) > 0 ||
        resource.mask.size > 0 ||
        resource.only !== null;

      if (resource.capture === "full" && !declares) {
        warnings.push(
          `"${alias}" captures full values but declares no hidden/visible columns and no mask. ` +
            `Every column, including any you encrypt at the driver boundary, will be written ` +
            `to the activity log in the clear.`,
        );
      }
    }

    for (const warning of warnings) {
      this.app.logger.warning(`activity-logs:check: ${warning}`);
    }

    for (const error of errors) {
      this.app.logger.error(`activity-logs:check: ${error}`);
    }

    if (errors.length > 0) {
      process.exitCode = 1;

      return;
    }

    this.app.logger.info(
      `activity-logs:check: ${config.resources.size} resource(s) configured, no errors.`,
    );
  }
}
