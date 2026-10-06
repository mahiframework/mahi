import { Command } from "@mahiframework/cli";
import type { SettingsRegistry } from "../settings-registry.js";
import { SETTINGS_TOKEN } from "../tokens.js";
import { display } from "../value-codec.js";

/**
 * Print one setting's effective value, and nothing else.
 *
 * Bare so it is pipeable — `VALUE=$(./artisan settings:get
 * import_batch_size)` yields `100` — which is what makes it usable from
 * a deploy script or a health check. `settings:list` is the human view.
 *
 * `process.stdout.write`, NOT `this.line()`: `Tui.note` indents by a
 * space and pads with blank lines, so a caller capturing the output
 * would have to trim it and would silently break if that formatting ever
 * changed. `health --json` sets the precedent for a command bypassing
 * Tui when the output is machine-destined.
 *
 * An unknown key throws `UnknownSettingError` from the registry rather
 * than printing an empty line, so a typo in a script fails rather than
 * silently reading as "unset".
 */
export class SettingsGetCommand extends Command {
  signature = "settings:get <key>";
  description = "Print one setting's current value.";

  async handle(key: string): Promise<void> {
    const registry = this.app.make<SettingsRegistry>(SETTINGS_TOKEN);

    process.stdout.write(`${display(await registry.get(key))}\n`);
  }
}
