import { Command } from "@mahiframework/cli";
import type { SettingsRegistry } from "../settings-registry.js";
import { SETTINGS_TOKEN } from "../tokens.js";
import { display, parseInput } from "../value-codec.js";

/**
 * Set one setting from the command line.
 *
 * The value arrives as text and is parsed against the setting's declared
 * type, so `settings:set import_feature_enabled true` stores a boolean
 * rather than the string `"true"`. A `json` or `array` setting takes JSON
 * text (`'["a","b"]'`), deliberately rather than a comma-separated list:
 * a setting whose values can contain commas would otherwise have no way
 * to say so.
 *
 * The write is recorded with a null actor. A command has no
 * authenticated user, and attributing it to one would be a lie — the
 * `null` in `edited_by_user_id` is what says "this came from an
 * operator, not the application".
 */
export class SettingsSetCommand extends Command {
  signature = "settings:set <key> <value>";
  description = "Set one setting's value, parsed against its declared type.";

  async handle(key: string, value: string): Promise<void> {
    const registry = this.app.make<SettingsRegistry>(SETTINGS_TOKEN);
    // Throws `UnknownSettingError` before anything is parsed, so a typo'd
    // key reports itself rather than a confusing parse failure.
    const definition = registry.definition(key);

    await registry.set(key, parseInput(key, definition.type, value), null);

    this.info(`${key} is now ${display(await registry.get(key))}.`);
  }
}
