import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Command as CommanderCommand } from "commander";
import { Command } from "../command.js";
import { FileExistsError } from "./make/scaffold.js";

/**
 * The primary-key column a scaffolded `create` migration should emit, kept
 * in lockstep with the model/factory `make:model` writes, so a
 * `make:model -m` never produces a `bigint` auto-increment column against a
 * client-generated string key (or vice versa). See `make-model.ts`.
 */
export type KeyType = "id" | "uuid" | "uuidv7";

export interface MakeMigrationOptions {
  /** Directory to write into. */
  dir: string;
  /**
   * Force `Schema.table("<table>")` (an `ALTER TABLE` migration) against
   * this table, regardless of the migration name. Mirrors Laravel's
   * `--table`.
   */
  table?: string;
  /**
   * Force `Schema.create("<table>")` against this table, regardless of the
   * name. Mirrors Laravel's `--create`.
   */
  create?: string;
  /** Primary-key column style for a `create` migration. Defaults to `id`. */
  keyType?: KeyType;
  /** Overwrite an existing file instead of refusing. */
  force?: boolean;
}

interface Plan {
  kind: "create" | "table" | "stub";
  table: string;
}

/**
 * Work out what a migration named `name` is meant to do, the way Laravel's
 * `MigrateMakeCommand` does:
 *
 * - `create_posts_table`      → `Schema.create("posts", …)`
 * - `add_slug_to_posts_table` → `Schema.table("posts", …)` (ALTER)
 * - anything else             → an empty stub (both `up`/`down` commented)
 *
 * Explicit `--create=<table>` / `--table=<table>` override the name entirely.
 * The previous behaviour, always `Schema.create` with a literal `"..."`
 * table when the name did not match `create_*_table`, produced
 * `create table ""."" (…)`, which Kysely parses as a schema-qualified name
 * and the database rejects, aborting the whole `migrate` run.
 */
function planFor(name: string, options: MakeMigrationOptions): Plan {
  if (options.create !== undefined) {
    return { kind: "create", table: options.create };
  }

  if (options.table !== undefined) {
    return { kind: "table", table: options.table };
  }

  const createMatch = /^create_(.+)_table$/.exec(name);

  if (createMatch) {
    return { kind: "create", table: createMatch[1]! };
  }

  const alterMatch = /_(?:to|from|in)_(.+)_table$/.exec(name);

  if (alterMatch) {
    return { kind: "table", table: alterMatch[1]! };
  }

  return { kind: "stub", table: "" };
}

/**
 * The primary-key line inside a `create` blueprint.
 *
 * Both UUID forms get a real `uuid` column rather than a generic string:
 * Postgres then stores 16 bytes instead of 36 and validates the format,
 * and the other engines fall back to a fixed-width char.
 */
function idLine(keyType: KeyType): string {
  return keyType === "id" ? "table.id();" : 'table.uuid("id").primary();';
}

function template(name: string, options: MakeMigrationOptions): string {
  const plan = planFor(name, options);
  const header = `import { Schema, type Migration, type Blueprint } from "@mahiframework/database";\n`;

  if (plan.kind === "create") {
    return `${header}
const migration: Migration = {
  async up(): Promise<void> {
    await Schema.create("${plan.table}", (table: Blueprint) => {
      ${idLine(options.keyType ?? "id")}
      table.timestamps();
    });
  },

  async down(): Promise<void> {
    await Schema.dropIfExists("${plan.table}");
  },
};

export default migration;
`;
  }

  if (plan.kind === "table") {
    return `${header}
const migration: Migration = {
  async up(): Promise<void> {
    await Schema.table("${plan.table}", (table: Blueprint) => {
      // table.string("column");
    });
  },

  async down(): Promise<void> {
    await Schema.table("${plan.table}", (table: Blueprint) => {
      // table.dropColumn("column");
    });
  },
};

export default migration;
`;
  }

  // Unrecognised name: an empty stub the author fills in. Emitting DDL
  // against a guessed table name would break `migrate`.
  return `${header}
const migration: Migration = {
  async up(): Promise<void> {
    // await Schema.create("table", (table: Blueprint) => { ... });
    // await Schema.table("table", (table: Blueprint) => { ... });
  },

  async down(): Promise<void> {
    // await Schema.dropIfExists("table");
  },
};

export default migration;
`;
}

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");

  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export class MakeMigrationCommand extends Command {
  // Writes into the application's source tree; meaningless without one.
  static override devOnly = true;

  signature = "make:migration <name>";
  description = "Scaffold a new migration file.";

  configure(program: CommanderCommand): void {
    program
      .option("-d, --dir <dir>", "Directory to write into", "database/migrations")
      .option("--table <table>", "Generate an ALTER migration for the given table")
      .option("--create <table>", "Generate a create migration for the given table")
      .option("-f, --force", "Overwrite the file if it already exists");
  }

  async handle(name: string, options: MakeMigrationOptions): Promise<void> {
    const dir = options.dir;
    await mkdir(dir, { recursive: true });

    const filename = `${timestamp()}_${name}.ts`;
    const filePath = path.join(dir, filename);

    if (!options.force && existsSync(filePath)) {
      throw new FileExistsError(filePath);
    }

    await writeFile(filePath, template(name, options));

    console.log(`Created migration: ${filePath}`);
  }
}
