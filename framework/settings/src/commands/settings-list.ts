import type { Command as CommanderCommand } from "commander";
import { Command } from "@mahiframework/cli";
import type { SettingsRegistry } from "../settings-registry.js";
import { SETTINGS_TOKEN } from "../tokens.js";
import { display } from "../value-codec.js";

/**
 * Print every declared setting and its effective value.
 *
 * The answer to "what is this application actually configured to do",
 * which no single table holds: a setting with no row is its declared
 * default, and only the registry knows both halves. The `Customised`
 * column is what distinguishes them, so a value that looks wrong can be
 * traced to either a bad default in code or a bad row in the database.
 *
 * Reads through the same cache the application reads, so it shows what
 * the app currently BELIEVES rather than what the table says — the more
 * useful answer when the suspicion is a stale cache. Follow with
 * `settings:cache-reset` to compare.
 */
export class SettingsListCommand extends Command {
  signature = "settings:list";
  description = "Print every declared setting, its type, and its current value.";

  configure(program: CommanderCommand): void {
    program.option("--category <category>", "Only show settings in this category");
    program.option("--customised", "Only show settings that differ from their default");
    program.option("--verbose", "Include each setting's description");
  }

  async handle(
    options: { category?: string; customised?: boolean; verbose?: boolean } = {},
  ): Promise<void> {
    const registry = this.app.make<SettingsRegistry>(SETTINGS_TOKEN);
    const values = await registry.all();
    const rows: (string | number)[][] = [];

    for (const [key, definition] of registry.definitions()) {
      if (options.category !== undefined && (definition.category ?? "") !== options.category) {
        continue;
      }

      const customised = await registry.isCustomised(key);

      if (options.customised === true && !customised) {
        continue;
      }

      const row: (string | number)[] = [
        key,
        definition.category ?? "—",
        definition.type,
        display(values[key]),
        customised ? "yes" : "no",
      ];

      if (options.verbose === true) {
        row.push(definition.description ?? "—");
      }

      rows.push(row);
    }

    if (rows.length === 0) {
      this.line(
        options.category === undefined
          ? "No settings are declared."
          : `No settings are declared in category "${options.category}".`,
      );

      return;
    }

    const headers = ["Setting", "Category", "Type", "Value", "Customised"];

    if (options.verbose === true) {
      headers.push("Description");
    }

    this.table(headers, rows);
  }
}
