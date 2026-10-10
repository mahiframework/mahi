import { Facade } from "@mahiframework/facades";
import type { Assignee } from "./assignee.js";
import type { Permission } from "./models/permission.model.js";
import type { Role } from "./models/role.model.js";
import type {
  GuardOption,
  PermissionRef,
  PermissionRegistrar,
  RoleRef,
} from "./permission-registrar.js";
import type { AssigneeKeyType } from "./permissions-config.js";
import { withPermissionCache } from "./request-cache.js";
import { PERMISSIONS_TOKEN } from "./tokens.js";

/**
 * Thin facade over the `PermissionRegistrar` singleton bound at
 * `PERMISSIONS_TOKEN`.
 *
 *   await Permissions.assignRole(user, "admin");
 *   if (await Permissions.hasPermissionTo(user, "posts.edit")) { ... }
 *
 * Every method takes the subject explicitly. Laravel's spatie package
 * reads `$user->assignRole(...)` off a trait, and this framework has no
 * traits and no package that touches the app's `User` model — behaviour
 * is attached through a container singleton, never by extending a model
 * the app owns. The explicit subject also works where a method could
 * not: on any polymorphic entity uniformly, and in a queue job holding
 * only a `{ type, id }` descriptor.
 *
 * Every call is `async`. There is no synchronous variant, and there
 * cannot be: the first check of a process reads the database.
 */
export class Permissions extends Facade<PermissionRegistrar>(() => PERMISSIONS_TOKEN) {
  // --------------------------------------------------------- roles/permissions

  static createRole(name: string, options?: GuardOption): Promise<Role> {
    return this.instance().createRole(name, options);
  }

  static createPermission(name: string, options?: GuardOption): Promise<Permission> {
    return this.instance().createPermission(name, options);
  }

  static findOrCreateRole(name: string, options?: GuardOption): Promise<Role> {
    return this.instance().findOrCreateRole(name, options);
  }

  static findOrCreatePermission(name: string, options?: GuardOption): Promise<Permission> {
    return this.instance().findOrCreatePermission(name, options);
  }

  static findRole(name: string, options?: GuardOption): Promise<Role> {
    return this.instance().findRole(name, options);
  }

  static findPermission(name: string, options?: GuardOption): Promise<Permission> {
    return this.instance().findPermission(name, options);
  }

  static deleteRole(role: RoleRef, options?: GuardOption): Promise<void> {
    return this.instance().deleteRole(role, options);
  }

  static deletePermission(permission: PermissionRef, options?: GuardOption): Promise<void> {
    return this.instance().deletePermission(permission, options);
  }

  // ------------------------------------------------------ role -> permissions

  static givePermissionToRole(
    role: RoleRef,
    permissions: PermissionRef | PermissionRef[],
    options?: GuardOption,
  ): Promise<void> {
    return this.instance().givePermissionToRole(role, permissions, options);
  }

  static revokePermissionFromRole(
    role: RoleRef,
    permissions: PermissionRef | PermissionRef[],
    options?: GuardOption,
  ): Promise<void> {
    return this.instance().revokePermissionFromRole(role, permissions, options);
  }

  static syncRolePermissions(
    role: RoleRef,
    permissions: PermissionRef | PermissionRef[],
    options?: GuardOption,
  ): Promise<void> {
    return this.instance().syncRolePermissions(role, permissions, options);
  }

  // ---------------------------------------------------------- subject -> roles

  static assignRole(
    assignee: Assignee,
    roles: RoleRef | RoleRef[],
    options?: GuardOption,
  ): Promise<void> {
    return this.instance().assignRole(assignee, roles, options);
  }

  static removeRole(
    assignee: Assignee,
    roles: RoleRef | RoleRef[],
    options?: GuardOption,
  ): Promise<void> {
    return this.instance().removeRole(assignee, roles, options);
  }

  /** Makes the subject's roles exactly `roles`. An empty array removes all of them. */
  static syncRoles(
    assignee: Assignee,
    roles: RoleRef | RoleRef[],
    options?: GuardOption,
  ): Promise<void> {
    return this.instance().syncRoles(assignee, roles, options);
  }

  // ---------------------------------------------------- subject -> permissions

  static givePermissionTo(
    assignee: Assignee,
    permissions: PermissionRef | PermissionRef[],
    options?: GuardOption,
  ): Promise<void> {
    return this.instance().givePermissionTo(assignee, permissions, options);
  }

  static revokePermissionTo(
    assignee: Assignee,
    permissions: PermissionRef | PermissionRef[],
    options?: GuardOption,
  ): Promise<void> {
    return this.instance().revokePermissionTo(assignee, permissions, options);
  }

  /** Makes the subject's DIRECT permissions exactly `permissions`. Roles are untouched. */
  static syncPermissions(
    assignee: Assignee,
    permissions: PermissionRef | PermissionRef[],
    options?: GuardOption,
  ): Promise<void> {
    return this.instance().syncPermissions(assignee, permissions, options);
  }

  // --------------------------------------------------------------- the checks

  static hasRole(
    assignee: Assignee,
    role: string | bigint,
    options?: GuardOption,
  ): Promise<boolean> {
    return this.instance().hasRole(assignee, role, options);
  }

  static hasAnyRole(
    assignee: Assignee,
    roles: Array<string | bigint>,
    options?: GuardOption,
  ): Promise<boolean> {
    return this.instance().hasAnyRole(assignee, roles, options);
  }

  static hasAllRoles(
    assignee: Assignee,
    roles: Array<string | bigint>,
    options?: GuardOption,
  ): Promise<boolean> {
    return this.instance().hasAllRoles(assignee, roles, options);
  }

  /** True if the subject holds this permission by ANY route: a role, or directly. */
  static hasPermissionTo(
    assignee: Assignee,
    permission: string | bigint,
    options?: GuardOption,
  ): Promise<boolean> {
    return this.instance().hasPermissionTo(assignee, permission, options);
  }

  static hasAnyPermission(
    assignee: Assignee,
    permissions: Array<string | bigint>,
    options?: GuardOption,
  ): Promise<boolean> {
    return this.instance().hasAnyPermission(assignee, permissions, options);
  }

  static hasAllPermissions(
    assignee: Assignee,
    permissions: Array<string | bigint>,
    options?: GuardOption,
  ): Promise<boolean> {
    return this.instance().hasAllPermissions(assignee, permissions, options);
  }

  /** True only if granted directly. A permission held via a role answers false here. */
  static hasDirectPermission(
    assignee: Assignee,
    permission: string | bigint,
    options?: GuardOption,
  ): Promise<boolean> {
    return this.instance().hasDirectPermission(assignee, permission, options);
  }

  // ------------------------------------------------------------ introspection

  static getRoleNames(assignee: Assignee, options?: GuardOption): Promise<Set<string>> {
    return this.instance().getRoleNames(assignee, options);
  }

  static getAllPermissions(assignee: Assignee, options?: GuardOption): Promise<Set<string>> {
    return this.instance().getAllPermissions(assignee, options);
  }

  static getDirectPermissions(assignee: Assignee, options?: GuardOption): Promise<Set<string>> {
    return this.instance().getDirectPermissions(assignee, options);
  }

  static getPermissionsViaRoles(assignee: Assignee, options?: GuardOption): Promise<Set<string>> {
    return this.instance().getPermissionsViaRoles(assignee, options);
  }

  // -------------------------------------------------------------------- cache

  /** Drop the cached role/permission map and every memoised assignment. */
  static forgetCache(): Promise<void> {
    return this.instance().forgetCache();
  }

  /** The key type this install's assignment pivots are built for. */
  static assigneeKeyType(): AssigneeKeyType {
    return this.instance().assigneeKeyType();
  }

  /**
   * Run `callback` with a per-subject assignment memo, for a job or
   * command that makes several checks. HTTP requests already have one,
   * opened by the provider's middleware.
   */
  static withCache<T>(callback: () => T | Promise<T>): Promise<T> {
    return withPermissionCache(callback);
  }
}
