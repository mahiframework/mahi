import { Command } from "@mahiframework/cli";
import type { SettingsRegistry } from "../settings-registry.js";
import { SETTINGS_TOKEN } from "../tokens.js";
import { display } from "../value-codec.js";

/**
 * Revert one setting to the default its definition declares, by deleting
 * its row.
 *
 * The escape hatch for a stored value that no longer decodes — a
 * definition whose `type` changed after a value was written makes
 * `settings:get` throw, and this is what clears it without a hand-written
 * `DELETE`.
 *
 * Reports whether anything was actually stored, so running it twice is
 * both safe and honest about the second one being a no-op.
 */
export class SettingsForgetCommand extends Command {
  signature = "settings:forget <key>";
  description = "Delete one setting's stored value, reverting it to its default.";

  async handle(key: string): Promise<void> {
    const registry = this.app.make<SettingsRegistry>(SETTINGS_TOKEN);
    const customised = await registry.isCustomised(key);

    if (!customised) {
      this.line(`${key} was already at its default; nothing to forget.`);

      return;
    }

    await registry.forget(key);

    this.info(`${key} reverted to its default, ${display(await registry.get(key))}.`);
  }
}
