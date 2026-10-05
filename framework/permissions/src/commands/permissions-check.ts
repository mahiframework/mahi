import { Command } from "@mahiframework/cli";
import { DB, Relation } from "@mahiframework/database";
import { PermissionRegistrar } from "../permission-registrar.js";
import { PERMISSIONS_TOKEN } from "../tokens.js";

/** One distinct `(model_type)` with how many assignment rows name it. */
interface AliasCount {
  model_type: string;
  total: number;
}

/**
 * Validate stored assignment rows against the models and guards that
 * exist.
 *
 * Two things can rot without anything noticing:
 *
 * 1. A `model_type` that names no model. Assignment rows store a morph
 *    alias, and `morphAlias()` falls back to the TABLE NAME when no
 *    `Relation.morphMap()` entry exists — so renaming a table orphans
 *    every row that named the old one. The rows stay, the checks stop
 *    matching, and nothing errors. This is the whole argument for
 *    `Relation.enforceMorphMap()`, and this command is how an app
 *    without one finds out.
 *
 * 2. A `guard_name` naming no configured guard. `guard_name` is NOT NULL
 *    with no wildcard, so a role created under a guard that was later
 *    renamed in `config/auth.ts` can never again satisfy a check.
 *
 * A CHECK, not a boot failure. A model can legitimately be registered by
 * a provider this command never loads, so an unmatched alias is reported
 * rather than fatal at runtime. Exits non-zero so CI can gate on it.
 */
export class PermissionsCheckCommand extends Command {
  signature = "permissions:check";
  description = "Validate stored role/permission assignments against models and guards.";

  async handle(): Promise<void> {
    const registrar = this.app.make<PermissionRegistrar>(PERMISSIONS_TOKEN);
    const map = await registrar.map();
    const errors: string[] = [];

    for (const alias of await this.assignedAliases()) {
      if (Relation.getMorphedModel(alias.model_type) !== undefined) {
        continue;
      }

      errors.push(
        `"${alias.model_type}" names no registered model, but ${alias.total} assignment row(s) ` +
          `use it. Morph aliases come from a Relation.morphMap() entry, a static morphName, or ` +
          `the table name — a renamed table orphans rows that named the old one. Register the ` +
          `alias with Relation.morphMap(), or delete the rows.`,
      );
    }

    // Read straight off the map rather than the tables: it is already
    // loaded, and a guard present in the cache but not in config is the
    // same defect as one present in the table.
    const guards = new Set<string>();

    for (const role of map.roles) {
      guards.add(role.guardName);
    }

    for (const permission of map.permissions) {
      guards.add(permission.guardName);
    }

    const configured = this.configuredGuards();

    if (configured !== null) {
      for (const guard of guards) {
        if (!configured.has(guard)) {
          errors.push(
            `guard "${guard}" is used by a role or permission but is not configured in ` +
              `config/auth.ts. Nothing can ever check against it.`,
          );
        }
      }
    }

    for (const error of errors) {
      this.app.logger.error(`permissions:check: ${error}`);
    }

    if (errors.length > 0) {
      process.exitCode = 1;

      return;
    }

    this.app.logger.info(
      `permissions:check: ${map.roles.length} role(s), ${map.permissions.length} permission(s), ` +
        `${guards.size} guard(s), no errors.`,
    );
  }

  /** Every distinct `model_type` across both assignment tables, with a row count. */
  private async assignedAliases(): Promise<AliasCount[]> {
    const tally = new Map<string, number>();

    for (const table of ["model_has_roles", "model_has_permissions"]) {
      const rows = await DB.table<{ model_type: string }>(table).select("model_type").get();

      for (const row of rows) {
        tally.set(row.model_type, (tally.get(row.model_type) ?? 0) + 1);
      }
    }

    return [...tally].map(([model_type, total]) => ({ model_type, total }));
  }

  /**
   * The app's configured guard names, or null if auth isn't configured at
   * all — in which case there is nothing to validate against and the
   * guard check is skipped rather than reporting every guard as unknown.
   */
  private configuredGuards(): Set<string> | null {
    const guards = this.app.config.get<Record<string, unknown>>("auth.guards");

    return guards === undefined ? null : new Set(Object.keys(guards));
  }
}
