import type { Command as CommanderCommand } from "commander";
import { Command } from "@mahiframework/cli";
import { PermissionRegistrar } from "../permission-registrar.js";
import { PERMISSIONS_TOKEN } from "../tokens.js";

/**
 * Print every role and what it grants.
 *
 * The answer to "why can this user do that", which is otherwise five
 * tables and a join. Reads the same cached map the checks read, so it
 * shows what the application currently BELIEVES rather than what the
 * tables say — which is the more useful answer when the suspicion is a
 * stale cache. Follow with `permissions:cache-reset` to compare.
 */
export class PermissionsShowCommand extends Command {
  signature = "permissions:show";
  description = "Print every role, its guard, and the permissions it grants.";

  configure(program: CommanderCommand): void {
    program.option("--guard <guard>", "Only show roles and permissions for this guard");
  }

  async handle(options: { guard?: string } = {}): Promise<void> {
    const map = await this.app.make<PermissionRegistrar>(PERMISSIONS_TOKEN).map();
    const guard = options.guard;

    const roles = guard === undefined ? map.roles : map.roles.filter((r) => r.guardName === guard);
    const permissions =
      guard === undefined ? map.permissions : map.permissions.filter((p) => p.guardName === guard);

    if (roles.length === 0 && permissions.length === 0) {
      this.line(
        guard === undefined
          ? "No roles or permissions are defined."
          : `No roles or permissions are defined for guard "${guard}".`,
      );

      return;
    }

    this.table(
      ["Role", "Guard", "Permissions"],
      roles.map((role) => [
        role.name,
        role.guardName,
        role.permissionIds
          .map((id) => map.permissionById.get(id)?.name ?? `<missing ${id}>`)
          .sort()
          .join(", ") || "—",
      ]),
    );

    // Listed separately because a permission attached to no role is
    // invisible above, and an unattached permission is usually either a
    // direct grant or a typo — both worth seeing.
    const attached = new Set(roles.flatMap((role) => role.permissionIds.map(String)));
    const orphans = permissions.filter((p) => !attached.has(String(p.id)));

    if (orphans.length > 0) {
      this.line("");
      this.line("Permissions not granted by any role (direct grants only):");
      this.table(
        ["Permission", "Guard"],
        orphans.map((permission) => [permission.name, permission.guardName]),
      );
    }
  }
}
