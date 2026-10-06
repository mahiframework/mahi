import { Command } from "@mahiframework/cli";
import { Setting } from "../settings-facade.js";

/**
 * Forget the cached settings map.
 *
 * Every write through the registry already does this, and the
 * model-event listener covers writes that bypass it — so reaching for
 * this means something escaped both, which is worth knowing about. It
 * exists because the alternative when that happens is waiting out the
 * TTL.
 */
export class SettingsCacheResetCommand extends Command {
  signature = "settings:cache-reset";
  description = "Forget the cached settings map.";

  async handle(): Promise<void> {
    await Setting.forgetCache();

    this.app.logger.info("settings:cache-reset forgot the cached settings map.");
  }
}
