import type { Application } from "@mahiframework/core";
import { AUTH_TOKEN, CACHE_TOKEN } from "@mahiframework/core";
import type { CacheManager } from "@mahiframework/cache";
import { DB } from "@mahiframework/database";
import {
  assigneeCacheKey,
  resolveAssignee,
  type Assignee,
  type ResolvedAssignee,
} from "./assignee.js";
import {
  DuplicateNameError,
  PermissionNotFoundError,
  RoleNotFoundError,
  UnresolvedGuardError,
} from "./errors.js";
import {
  buildMap,
  deserializeMap,
  mapKey,
  serializeMap,
  type MappedPermission,
  type MappedRole,
  type PermissionMap,
  type SerializedPermissionMap,
} from "./permission-map.js";
import { Permission } from "./models/permission.model.js";
import { Role } from "./models/role.model.js";
import {
  assignmentMemo,
  forgetMemoisedAssignments,
  type AssignmentRecord,
} from "./request-cache.js";
import type { ResolvedPermissionsConfig } from "./permissions-config.js";

/** Options every name-addressed call accepts. */
export interface GuardOption {
  /** The auth guard to scope to. Defaults to config `guard`, then `auth.default`. */
  guard?: string;
}

/** A role named by name, id, or instance. */
export type RoleRef = string | bigint | Role;

/** A permission named by name, id, or instance. */
export type PermissionRef = string | bigint | Permission;

/**
 * Row shapes for the model-free `DB.table()` reads below.
 *
 * Declared as the FULL table shape rather than only the columns each
 * query selects: `QueryBuilder<TRow>` types `where()` against `TRow`'s
 * keys, so a row type narrowed to the selection makes filtering on any
 * other column a compile error.
 */
interface RoleRow {
  id: bigint;
  name: string;
  guard_name: string;
}

interface PermissionRow {
  id: bigint;
  name: string;
  guard_name: string;
}

interface RolePermissionRow {
  role_id: bigint;
  permission_id: bigint;
}

interface ModelRoleRow {
  role_id: bigint;
  model_type: string;
  model_id: bigint;
}

interface ModelPermissionRow {
  permission_id: bigint;
  model_type: string;
  model_id: bigint;
}

/**
 * The shape read off `@mahiframework/auth` to find the default guard,
 * resolved by string token at runtime rather than by importing
 * `AuthManager`, so a lookup never forces that package to be installed.
 */
interface DefaultGuardSource {
  getDefaultDriver(): string;
}

/** Roles and permissions, their relationships, and who holds them. */
export class PermissionRegistrar {
  constructor(
    private readonly app: Application,
    private readonly config: ResolvedPermissionsConfig,
  ) {}

  // ---------------------------------------------------------------- guards

  /**
   * The guard a call operates on.
   *
   * `auth.default` is the last resort rather than the ambient
   * `currentGuard()`, which would read the guard that authenticated THIS
   * request. That is tempting and wrong: it throws outside a request
   * scope (`MissingAuthContextError`), so a queue job or a seeder
   * assigning a role would crash, and it would make the same
   * `createRole("admin")` produce a different row depending on who
   * happened to call it.
   *
   * Throws rather than defaulting to `""`: `guard_name` is NOT NULL with
   * no wildcard, so an unresolvable guard has no safe representation, and
   * a role stamped with the empty string is a role no check will ever
   * match.
   */
  guardName(options: GuardOption = {}): string {
    const named = options.guard ?? this.config.guard ?? this.defaultGuard();

    if (named === null || named === "") {
      throw new UnresolvedGuardError();
    }

    return named;
  }

  private defaultGuard(): string | null {
    if (!this.app.has(AUTH_TOKEN)) {
      return null;
    }

    return this.app.make<DefaultGuardSource>(AUTH_TOKEN).getDefaultDriver();
  }

  // ----------------------------------------------------------- the cache

  /**
   * The role/permission map, from cache or the database.
   *
   * `remember()` treats `undefined` as its miss sentinel, so the loader
   * must never return it — this one always returns an object, even for an
   * app with no roles at all.
   *
   * The map crosses the cache boundary serialised (ids as strings): see
   * `permission-map.ts` for why a `bigint` cannot be cached.
   */
  async map(): Promise<PermissionMap> {
    const store = this.cache().store(this.config.cacheStore);

    const serialized = await store.remember<SerializedPermissionMap>(
      this.config.cacheKey,
      () => this.loadMap(),
      this.config.cacheTtlSeconds,
    );

    return deserializeMap(serialized);
  }

  /** Read every role, permission, and role-permission link. Three queries, no joins. */
  private async loadMap(): Promise<SerializedPermissionMap> {
    const [roleRows, permissionRows, links] = await Promise.all([
      DB.table<RoleRow>("roles").select("id", "name", "guard_name").get(),
      DB.table<PermissionRow>("permissions").select("id", "name", "guard_name").get(),
      DB.table<RolePermissionRow>("role_has_permissions").select("role_id", "permission_id").get(),
    ]);

    const grouped = new Map<string, bigint[]>();

    for (const link of links) {
      const key = String(link.role_id);
      const existing = grouped.get(key);

      if (existing === undefined) {
        grouped.set(key, [BigInt(link.permission_id)]);
      } else {
        existing.push(BigInt(link.permission_id));
      }
    }

    const roles: MappedRole[] = roleRows.map((row) => ({
      id: BigInt(row.id),
      name: row.name,
      guardName: row.guard_name,
      permissionIds: grouped.get(String(row.id)) ?? [],
    }));

    const permissions: MappedPermission[] = permissionRows.map((row) => ({
      id: BigInt(row.id),
      name: row.name,
      guardName: row.guard_name,
    }));

    return serializeMap(buildMap(roles, permissions));
  }

  /**
   * Drop the cached map and every memoised assignment.
   *
   * Called by every write here, and by the model-event listeners for
   * writes that bypass this class (a seeder calling `Role.create()`).
   * Forgets exactly one key — `@mahiframework/cache` has no tags, so
   * there is no flush-by-pattern, and `flush()` would take out the app's
   * entire cache.
   */
  async forgetCache(): Promise<void> {
    forgetMemoisedAssignments();
    await this.cache().store(this.config.cacheStore).forget(this.config.cacheKey);
  }

  private cache(): CacheManager {
    return this.app.make<CacheManager>(CACHE_TOKEN);
  }

  // ------------------------------------------------------ role/permission CRUD

  /** Create a role. Throws if one already exists with this name for this guard. */
  async createRole(name: string, options: GuardOption = {}): Promise<Role> {
    const guard = this.guardName(options);

    if ((await this.map()).roleByName.has(mapKey(guard, name))) {
      throw new DuplicateNameError("role", name, guard);
    }

    const role = await Role.create({ name, guard_name: guard });
    await this.forgetCache();

    return role;
  }

  /** Create a permission. Throws if one already exists with this name for this guard. */
  async createPermission(name: string, options: GuardOption = {}): Promise<Permission> {
    const guard = this.guardName(options);

    if ((await this.map()).permissionByName.has(mapKey(guard, name))) {
      throw new DuplicateNameError("permission", name, guard);
    }

    const permission = await Permission.create({ name, guard_name: guard });
    await this.forgetCache();

    return permission;
  }

  /** Create a role only if it doesn't exist, returning either way. */
  async findOrCreateRole(name: string, options: GuardOption = {}): Promise<Role> {
    const guard = this.guardName(options);
    const existing = (await this.map()).roleByName.get(mapKey(guard, name));

    if (existing !== undefined) {
      return (await Role.findOrFail(existing.id)) as Role;
    }

    return this.createRole(name, { guard });
  }

  /** Create a permission only if it doesn't exist, returning either way. */
  async findOrCreatePermission(name: string, options: GuardOption = {}): Promise<Permission> {
    const guard = this.guardName(options);
    const existing = (await this.map()).permissionByName.get(mapKey(guard, name));

    if (existing !== undefined) {
      return (await Permission.findOrFail(existing.id)) as Permission;
    }

    return this.createPermission(name, { guard });
  }

  /** The role with this name, or `RoleNotFoundError`. */
  async findRole(name: string, options: GuardOption = {}): Promise<Role> {
    const guard = this.guardName(options);
    const mapped = (await this.map()).roleByName.get(mapKey(guard, name));

    if (mapped === undefined) {
      throw new RoleNotFoundError(name, guard);
    }

    return (await Role.findOrFail(mapped.id)) as Role;
  }

  /** The permission with this name, or `PermissionNotFoundError`. */
  async findPermission(name: string, options: GuardOption = {}): Promise<Permission> {
    const guard = this.guardName(options);
    const mapped = (await this.map()).permissionByName.get(mapKey(guard, name));

    if (mapped === undefined) {
      throw new PermissionNotFoundError(name, guard);
    }

    return (await Permission.findOrFail(mapped.id)) as Permission;
  }

  /**
   * Delete a role. Its assignments and permission links go with it, via
   * the pivots' `cascadeOnDelete` foreign keys.
   */
  async deleteRole(role: RoleRef, options: GuardOption = {}): Promise<void> {
    const id = await this.roleId(role, options);
    await Role.delete(id);
    await this.forgetCache();
  }

  /** Delete a permission. Its assignments and role links cascade. */
  async deletePermission(permission: PermissionRef, options: GuardOption = {}): Promise<void> {
    const id = await this.permissionId(permission, options);
    await Permission.delete(id);
    await this.forgetCache();
  }

  // --------------------------------------------------- role -> permissions

  /** Grant permissions to a role, ignoring any it already has. */
  async givePermissionToRole(
    role: RoleRef,
    permissions: PermissionRef | PermissionRef[],
    options: GuardOption = {},
  ): Promise<void> {
    const roleId = await this.roleId(role, options);
    const ids = await this.permissionIds(permissions, options);
    const held = new Set(
      ((await this.map()).roleById.get(roleId)?.permissionIds ?? []).map(String),
    );
    const missing = ids.filter((id) => !held.has(String(id)));

    if (missing.length === 0) {
      return;
    }

    await this.insertChunked(
      "role_has_permissions",
      missing.map((id) => ({ role_id: roleId, permission_id: id })),
    );
    await this.forgetCache();
  }

  /** Revoke permissions from a role. */
  async revokePermissionFromRole(
    role: RoleRef,
    permissions: PermissionRef | PermissionRef[],
    options: GuardOption = {},
  ): Promise<void> {
    const roleId = await this.roleId(role, options);
    const ids = await this.permissionIds(permissions, options);

    if (ids.length === 0) {
      return;
    }

    await DB.table<RolePermissionRow>("role_has_permissions")
      .where("role_id", roleId)
      .whereIn("permission_id", ids)
      .delete();
    await this.forgetCache();
  }

  /**
   * Make a role's permissions exactly this list.
   *
   * An empty list revokes everything, which is the whole point of a sync
   * and the one behaviour worth being explicit about: the framework's own
   * `detach([])` is a deliberate no-op, so a caller passing
   * `request.input("permissions")` through that API would silently keep
   * the old set. This writes pivots directly and means what it says.
   */
  async syncRolePermissions(
    role: RoleRef,
    permissions: PermissionRef | PermissionRef[],
    options: GuardOption = {},
  ): Promise<void> {
    const roleId = await this.roleId(role, options);
    const wanted = await this.permissionIds(permissions, options);

    await DB.transaction(async () => {
      await DB.table<RolePermissionRow>("role_has_permissions").where("role_id", roleId).delete();
      await this.insertChunked(
        "role_has_permissions",
        wanted.map((id) => ({ role_id: roleId, permission_id: id })),
      );
    });

    await this.forgetCache();
  }

  // ------------------------------------------------------- subject -> roles

  /** Assign roles to a subject. Already-held roles are skipped, so this is idempotent. */
  async assignRole(
    assignee: Assignee,
    roles: RoleRef | RoleRef[],
    options: GuardOption = {},
  ): Promise<void> {
    const subject = resolveAssignee(assignee);
    const ids = await this.roleIds(roles, options);
    const current = await this.assignmentsFor(subject);
    const held = new Set(current.roleIds.map(String));
    const missing = ids.filter((id) => !held.has(String(id)));

    if (missing.length === 0) {
      return;
    }

    await this.insertChunked(
      "model_has_roles",
      missing.map((id) => ({
        role_id: id,
        model_type: subject.morphType,
        model_id: subject.key,
      })),
    );
    forgetMemoisedAssignments(assigneeCacheKey(subject));
  }

  /** Remove roles from a subject. */
  async removeRole(
    assignee: Assignee,
    roles: RoleRef | RoleRef[],
    options: GuardOption = {},
  ): Promise<void> {
    const subject = resolveAssignee(assignee);
    const ids = await this.roleIds(roles, options);

    if (ids.length === 0) {
      return;
    }

    await DB.table<ModelRoleRow>("model_has_roles")
      .where("model_type", subject.morphType)
      .where("model_id", subject.key)
      .whereIn("role_id", ids)
      .delete();
    forgetMemoisedAssignments(assigneeCacheKey(subject));
  }

  /** Make a subject's roles exactly this list. An empty list removes all of them. */
  async syncRoles(
    assignee: Assignee,
    roles: RoleRef | RoleRef[],
    options: GuardOption = {},
  ): Promise<void> {
    const subject = resolveAssignee(assignee);
    const wanted = await this.roleIds(roles, options);

    await DB.transaction(async () => {
      await DB.table<ModelRoleRow>("model_has_roles")
        .where("model_type", subject.morphType)
        .where("model_id", subject.key)
        .delete();
      await this.insertChunked(
        "model_has_roles",
        wanted.map((id) => ({
          role_id: id,
          model_type: subject.morphType,
          model_id: subject.key,
        })),
      );
    });

    forgetMemoisedAssignments(assigneeCacheKey(subject));
  }

  // ------------------------------------------------- subject -> permissions

  /** Grant permissions to a subject directly, alongside whatever its roles grant. */
  async givePermissionTo(
    assignee: Assignee,
    permissions: PermissionRef | PermissionRef[],
    options: GuardOption = {},
  ): Promise<void> {
    const subject = resolveAssignee(assignee);
    const ids = await this.permissionIds(permissions, options);
    const current = await this.assignmentsFor(subject);
    const held = new Set(current.permissionIds.map(String));
    const missing = ids.filter((id) => !held.has(String(id)));

    if (missing.length === 0) {
      return;
    }

    await this.insertChunked(
      "model_has_permissions",
      missing.map((id) => ({
        permission_id: id,
        model_type: subject.morphType,
        model_id: subject.key,
      })),
    );
    forgetMemoisedAssignments(assigneeCacheKey(subject));
  }

  /**
   * Revoke a directly-granted permission.
   *
   * Only touches `model_has_permissions`. A permission the subject also
   * holds through a role survives this call, and `hasPermissionTo()` will
   * still answer true — which is correct, and the reason
   * `hasDirectPermission()` exists to tell the two apart.
   */
  async revokePermissionTo(
    assignee: Assignee,
    permissions: PermissionRef | PermissionRef[],
    options: GuardOption = {},
  ): Promise<void> {
    const subject = resolveAssignee(assignee);
    const ids = await this.permissionIds(permissions, options);

    if (ids.length === 0) {
      return;
    }

    await DB.table<ModelPermissionRow>("model_has_permissions")
      .where("model_type", subject.morphType)
      .where("model_id", subject.key)
      .whereIn("permission_id", ids)
      .delete();
    forgetMemoisedAssignments(assigneeCacheKey(subject));
  }

  /** Make a subject's direct permissions exactly this list. An empty list removes all of them. */
  async syncPermissions(
    assignee: Assignee,
    permissions: PermissionRef | PermissionRef[],
    options: GuardOption = {},
  ): Promise<void> {
    const subject = resolveAssignee(assignee);
    const wanted = await this.permissionIds(permissions, options);

    await DB.transaction(async () => {
      await DB.table<ModelPermissionRow>("model_has_permissions")
        .where("model_type", subject.morphType)
        .where("model_id", subject.key)
        .delete();
      await this.insertChunked(
        "model_has_permissions",
        wanted.map((id) => ({
          permission_id: id,
          model_type: subject.morphType,
          model_id: subject.key,
        })),
      );
    });

    forgetMemoisedAssignments(assigneeCacheKey(subject));
  }

  // ------------------------------------------------------------- the checks

  /** Does this subject hold this role? */
  async hasRole(
    assignee: Assignee,
    role: string | bigint,
    options: GuardOption = {},
  ): Promise<boolean> {
    return this.hasAnyRole(assignee, [role], options);
  }

  /** Does this subject hold at least one of these roles? */
  async hasAnyRole(
    assignee: Assignee,
    roles: Array<string | bigint>,
    options: GuardOption = {},
  ): Promise<boolean> {
    const names = await this.getRoleNames(assignee, options);
    const map = await this.map();
    const guard = this.guardName(options);

    return roles.some((role) => names.has(this.roleNameOf(map, role, guard)));
  }

  /** Does this subject hold every one of these roles? */
  async hasAllRoles(
    assignee: Assignee,
    roles: Array<string | bigint>,
    options: GuardOption = {},
  ): Promise<boolean> {
    const names = await this.getRoleNames(assignee, options);
    const map = await this.map();
    const guard = this.guardName(options);

    return roles.every((role) => names.has(this.roleNameOf(map, role, guard)));
  }

  /**
   * Does this subject hold this permission, by any route?
   *
   * An unknown permission name returns false rather than throwing. This
   * one is a check, not a write: the gate hook calls it with every
   * ability string in the app, almost none of which are permissions, so
   * throwing would turn `can("view-dashboard")` into a 500. The write
   * methods still throw on an unknown name, which is where a typo
   * actually matters.
   */
  async hasPermissionTo(
    assignee: Assignee,
    permission: string | bigint,
    options: GuardOption = {},
  ): Promise<boolean> {
    return this.hasAnyPermission(assignee, [permission], options);
  }

  /** Does this subject hold at least one of these permissions, by any route? */
  async hasAnyPermission(
    assignee: Assignee,
    permissions: Array<string | bigint>,
    options: GuardOption = {},
  ): Promise<boolean> {
    const held = await this.getAllPermissions(assignee, options);
    const map = await this.map();
    const guard = this.guardName(options);

    return permissions.some((permission) =>
      held.has(this.permissionNameOf(map, permission, guard)),
    );
  }

  /** Does this subject hold every one of these permissions, by any route? */
  async hasAllPermissions(
    assignee: Assignee,
    permissions: Array<string | bigint>,
    options: GuardOption = {},
  ): Promise<boolean> {
    const held = await this.getAllPermissions(assignee, options);
    const map = await this.map();
    const guard = this.guardName(options);

    return permissions.every((permission) =>
      held.has(this.permissionNameOf(map, permission, guard)),
    );
  }

  /** Does this subject hold this permission DIRECTLY, ignoring its roles? */
  async hasDirectPermission(
    assignee: Assignee,
    permission: string | bigint,
    options: GuardOption = {},
  ): Promise<boolean> {
    const held = await this.getDirectPermissions(assignee, options);
    const map = await this.map();

    return held.has(this.permissionNameOf(map, permission, this.guardName(options)));
  }

  // ------------------------------------------------------- introspection

  /** This subject's role names, for the resolved guard. */
  async getRoleNames(assignee: Assignee, options: GuardOption = {}): Promise<Set<string>> {
    const guard = this.guardName(options);
    const map = await this.map();
    const assignments = await this.assignmentsFor(resolveAssignee(assignee));
    const names = new Set<string>();

    for (const roleId of assignments.roleIds) {
      const role = map.roleById.get(roleId);

      // A guard mismatch is not a filter but the entire isolation
      // guarantee: an `api` role must not answer a `web` question, even
      // though the assignment row says the subject holds it.
      if (role !== undefined && role.guardName === guard) {
        names.add(role.name);
      }
    }

    return names;
  }

  /** Permission names this subject holds via its roles only. */
  async getPermissionsViaRoles(
    assignee: Assignee,
    options: GuardOption = {},
  ): Promise<Set<string>> {
    const guard = this.guardName(options);
    const map = await this.map();
    const assignments = await this.assignmentsFor(resolveAssignee(assignee));
    const names = new Set<string>();

    for (const roleId of assignments.roleIds) {
      const role = map.roleById.get(roleId);

      if (role === undefined || role.guardName !== guard) {
        continue;
      }

      for (const permissionId of role.permissionIds) {
        const permission = map.permissionById.get(permissionId);

        if (permission !== undefined && permission.guardName === guard) {
          names.add(permission.name);
        }
      }
    }

    return names;
  }

  /** Permission names granted to this subject directly, ignoring its roles. */
  async getDirectPermissions(assignee: Assignee, options: GuardOption = {}): Promise<Set<string>> {
    const guard = this.guardName(options);
    const map = await this.map();
    const assignments = await this.assignmentsFor(resolveAssignee(assignee));
    const names = new Set<string>();

    for (const permissionId of assignments.permissionIds) {
      const permission = map.permissionById.get(permissionId);

      if (permission !== undefined && permission.guardName === guard) {
        names.add(permission.name);
      }
    }

    return names;
  }

  /** Every permission name this subject holds, by either route. */
  async getAllPermissions(assignee: Assignee, options: GuardOption = {}): Promise<Set<string>> {
    const [viaRoles, direct] = await Promise.all([
      this.getPermissionsViaRoles(assignee, options),
      this.getDirectPermissions(assignee, options),
    ]);

    for (const name of direct) {
      viaRoles.add(name);
    }

    return viaRoles;
  }

  // ------------------------------------------------------------- internals

  /**
   * One subject's raw assignment ids, memoised per request.
   *
   * Two queries, in parallel, and at most once per subject per request.
   * The memo is what makes the gate hook affordable: it fires on every
   * authorization check, so a controller with five `can()` calls would
   * otherwise be ten queries against rows that cannot have changed.
   */
  private async assignmentsFor(subject: ResolvedAssignee): Promise<AssignmentRecord> {
    const memo = assignmentMemo();
    const key = assigneeCacheKey(subject);
    const cached = memo?.get(key);

    if (cached !== undefined) {
      return cached;
    }

    const [roleRows, permissionRows] = await Promise.all([
      DB.table<ModelRoleRow>("model_has_roles")
        .select("role_id")
        .where("model_type", subject.morphType)
        .where("model_id", subject.key)
        .get(),
      DB.table<ModelPermissionRow>("model_has_permissions")
        .select("permission_id")
        .where("model_type", subject.morphType)
        .where("model_id", subject.key)
        .get(),
    ]);

    const record: AssignmentRecord = {
      roleIds: roleRows.map((row) => BigInt(row.role_id)),
      permissionIds: permissionRows.map((row) => BigInt(row.permission_id)),
    };

    memo?.set(key, record);

    return record;
  }

  /** The role's name, whether it was named by name or by id. Unknown ids yield a non-matching sentinel. */
  private roleNameOf(map: PermissionMap, role: string | bigint, guard: string): string {
    if (typeof role === "string") {
      return role;
    }

    const mapped = map.roleById.get(role);

    return mapped !== undefined && mapped.guardName === guard ? mapped.name : UNMATCHABLE;
  }

  private permissionNameOf(map: PermissionMap, permission: string | bigint, guard: string): string {
    if (typeof permission === "string") {
      return permission;
    }

    const mapped = map.permissionById.get(permission);

    return mapped !== undefined && mapped.guardName === guard ? mapped.name : UNMATCHABLE;
  }

  /** Resolve a role reference to its id, throwing on an unknown name. */
  private async roleId(role: RoleRef, options: GuardOption): Promise<bigint> {
    if (typeof role === "bigint") {
      return role;
    }

    if (role instanceof Role) {
      return role.id;
    }

    const guard = this.guardName(options);
    const mapped = (await this.map()).roleByName.get(mapKey(guard, role));

    if (mapped === undefined) {
      throw new RoleNotFoundError(role, guard);
    }

    return mapped.id;
  }

  private async permissionId(permission: PermissionRef, options: GuardOption): Promise<bigint> {
    if (typeof permission === "bigint") {
      return permission;
    }

    if (permission instanceof Permission) {
      return permission.id;
    }

    const guard = this.guardName(options);
    const mapped = (await this.map()).permissionByName.get(mapKey(guard, permission));

    if (mapped === undefined) {
      throw new PermissionNotFoundError(permission, guard);
    }

    return mapped.id;
  }

  private async roleIds(roles: RoleRef | RoleRef[], options: GuardOption): Promise<bigint[]> {
    const list = Array.isArray(roles) ? roles : [roles];

    return Promise.all(list.map((role) => this.roleId(role, options)));
  }

  private async permissionIds(
    permissions: PermissionRef | PermissionRef[],
    options: GuardOption,
  ): Promise<bigint[]> {
    const list = Array.isArray(permissions) ? permissions : [permissions];

    return Promise.all(list.map((permission) => this.permissionId(permission, options)));
  }

  /**
   * Insert pivot rows, in chunks, as one multi-row statement each.
   *
   * Goes to raw Kysely rather than `QueryBuilder`, whose `insert()` takes
   * a single row: a per-row loop would turn a 500-permission sync into
   * 500 round trips. `Role.resolveConnection()` is the handle rather
   * than a `DatabaseManager` lookup because it swaps in the active
   * transaction when there is one, which is what makes the `sync*`
   * methods' delete-then-insert atomic.
   *
   * Chunked because pivot writes in this framework do not bound their
   * parameter count, and a multi-row insert binds one parameter per
   * column per row — three columns here, so a sync of 12,000 would
   * exceed SQLite's 32,766-binding ceiling (Postgres' is 65,535) and
   * fail at the driver rather than anywhere meaningful. 1,000 rows is
   * 3,000 bindings, well inside every engine. Sequential, since the
   * chunks all target one table inside one transaction.
   */
  private async insertChunked(
    table: string,
    rows: Array<Record<string, bigint | string>>,
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    const connection = Role.resolveConnection();

    for (let index = 0; index < rows.length; index += INSERT_CHUNK) {
      await connection
        .insertInto(table)
        .values(rows.slice(index, index + INSERT_CHUNK))
        .execute();
    }
  }
}

/**
 * A name no role or permission can have, returned when an id-addressed
 * lookup finds nothing. Returning this rather than throwing keeps
 * `hasAnyRole([someDeletedId, "admin"])` answering the question it was
 * asked; `\u0000` cannot appear in a name that came from the map, because
 * the map's own keys use it as a separator.
 */
const UNMATCHABLE = "\u0000unmatchable";

const INSERT_CHUNK = 1_000;
