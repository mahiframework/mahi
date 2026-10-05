import { Command } from "@mahiframework/cli";
import { Permissions } from "../permissions-facade.js";

/**
 * Forget the cached role/permission map.
 *
 * The registrar already does this on every write it performs, and the
 * model-event listeners cover writes that bypass it, so reaching for this
 * command means something escaped both: a raw `DB.table("roles")` insert,
 * a migration, a restored database dump.
 *
 * It forgets exactly ONE key and touches nothing else.
 * `@mahiframework/cache` has no tags, so there is no flush-by-pattern,
 * and `cache:clear` would take out the app's entire cache to fix a
 * problem with five tables.
 */
export class PermissionsCacheResetCommand extends Command {
  signature = "permissions:cache-reset";
  description = "Forget the cached role and permission map.";

  async handle(): Promise<void> {
    await Permissions.forgetCache();

    this.app.logger.info("permissions:cache-reset forgot the cached role/permission map.");
  }
}
