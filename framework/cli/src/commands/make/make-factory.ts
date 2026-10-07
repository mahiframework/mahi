import type { Command as CommanderCommand } from "commander";
import { Str } from "@mahiframework/core";
import { Command } from "../../command.js";
import { scaffold, toClassName } from "./scaffold.js";
import type { KeyType } from "../make-migration.js";

/** `PostFactory` -> `Post` (drop the trailing `Factory` for the referenced model). */
function modelName(className: string): string {
  return className.replace(/Factory$/, "");
}

/**
 * The factory never fills `id`, whatever the key strategy:
 *
 * - `id` (auto-increment), the DB assigns it on insert.
 * - `uuid` / `uuidv7`, the model's `keyType` strategy fills it
 *   before insert, via `newUniqueId()`.
 *
 * Filling it here would make the generated factory inconsistent with an
 * auto-increment `table.id()` column and crash `create()`.
 */
function template(className: string, keyType: KeyType): string {
  const model = modelName(className);
  const modelFile = Str.kebab(model);
  void keyType;

  return `import { Factory } from "@mahiframework/database";
import { ${model} } from "../../src/models/${modelFile}.model.js";

export class ${className} extends Factory<typeof ${model}> {
  protected model = ${model};

  // \`definition()\` returns MODEL-shape attributes (casts apply on insert).
  // \`id\` is intentionally omitted: it is assigned on insert (by the DB for
  // an auto-increment key, or by the model's key strategy for a
  // client-generated one), so the factory never sets a colliding key.
  protected definition() {
    return {
      // Add your fake column values here.
    };
  }
}
`;
}

export class MakeFactoryCommand extends Command {
  // Writes into the application's source tree; meaningless without one.
  static override devOnly = true;

  signature = "make:factory <name>";
  description = "Scaffold a new model Factory class.";

  configure(program: CommanderCommand): void {
    program
      .option("-d, --dir <dir>", "Directory to write into", "database/factories")
      .option("-f, --force", "Overwrite the file if it already exists");
  }

  async handle(
    name: string,
    options: { dir: string; keyType?: KeyType; force?: boolean },
  ): Promise<void> {
    const className = toClassName(name, "Factory");
    await scaffold({
      name,
      dir: options.dir,
      suffix: "Factory",
      template: (cls) => template(cls, options.keyType ?? "id"),
      filename: () => `${Str.kebab(modelName(className))}-factory.ts`,
      label: "factory",
      force: options.force,
    });
  }
}
