/**
 * The cached snapshot of every role, every permission, and which
 * permissions each role grants.
 *
 * ONE cache entry for the whole table set, which is spatie's model and
 * the only one `@mahiframework/cache` can support: it has no tags, so
 * there is no flush-by-pattern, and every key written must be a key
 * nameable later. One key is nameable. It is also bounded by the number
 * of roles and permissions an app defines (tens, not millions), unlike a
 * per-subject cache which grows with the user table.
 *
 * What is NOT in here: who holds what. `model_has_roles` scales with
 * users, so caching it under one key would mean one entry growing without
 * bound and invalidated by every assignment anywhere. Assignments are a
 * query, memoised per request (see `request-cache.ts`).
 *
 * ## The serialisation boundary
 *
 * `RedisCacheStore` and `FileCacheStore` persist with `JSON.stringify`,
 * and `JSON.stringify` THROWS on a `bigint` — deliberately: an id cannot
 * be serialised without a decision being made about it. The decision
 * here is a decimal string, matching `Resource` and `Model.toJSON()`.
 *
 * So the cached form (`SerializedPermissionMap`) carries strings and the
 * in-memory form (`PermissionMap`) carries `bigint`, with
 * `serializeMap`/`deserializeMap` the only crossing. Getting this wrong
 * is a bug that cannot be reproduced on `ArrayCacheStore`, which passes a
 * `bigint` through happily — it would appear only once an app switched to
 * redis or file, i.e. in production. Hence one module, two functions, and
 * a test that round-trips through `JSON.parse(JSON.stringify(...))`.
 */

/** A role as cached: its identity plus the permissions it grants. */
export interface MappedRole {
  id: bigint;
  name: string;
  guardName: string;
  /** Permission ids from `role_has_permissions`. */
  permissionIds: bigint[];
}

/** A permission as cached. */
export interface MappedPermission {
  id: bigint;
  name: string;
  guardName: string;
}

/**
 * The in-memory map, with lookup indexes derived once at
 * deserialisation rather than scanned per check.
 *
 * Keyed by `name` + `guardName` together, because the same name can exist
 * once per guard and a `web` role must not answer an `api` lookup.
 */
export interface PermissionMap {
  roles: MappedRole[];
  permissions: MappedPermission[];
  /** `"{guard}\u0000{name}"` -> role. */
  roleByName: Map<string, MappedRole>;
  /** `"{guard}\u0000{name}"` -> permission. */
  permissionByName: Map<string, MappedPermission>;
  /** Role id -> role, for turning an assignment row into permissions. */
  roleById: Map<bigint, MappedRole>;
  /** Permission id -> permission, for naming a directly-assigned permission. */
  permissionById: Map<bigint, MappedPermission>;
}

/** The JSON-safe form actually written to the cache store. */
export interface SerializedPermissionMap {
  roles: Array<{ id: string; name: string; guardName: string; permissionIds: string[] }>;
  permissions: Array<{ id: string; name: string; guardName: string }>;
}

/**
 * `"{guard}\0{name}"`.
 *
 * A NUL separator rather than `:` because a permission name is
 * app-chosen and may contain anything printable (`"billing:view"` is a
 * perfectly ordinary name), whereas a guard name comes from
 * `config/auth.ts`. Without a separator that cannot appear in either
 * half, `("web", "a:b")` and `("web:a", "b")` would collide — and the
 * collision would grant a permission nobody assigned.
 */
export function mapKey(guardName: string, name: string): string {
  return `${guardName}\u0000${name}`;
}

/** Strip the `bigint`s out, for the cache store. */
export function serializeMap(map: PermissionMap): SerializedPermissionMap {
  return {
    roles: map.roles.map((role) => ({
      id: String(role.id),
      name: role.name,
      guardName: role.guardName,
      permissionIds: role.permissionIds.map(String),
    })),
    permissions: map.permissions.map((permission) => ({
      id: String(permission.id),
      name: permission.name,
      guardName: permission.guardName,
    })),
  };
}

/** Put the `bigint`s back, and build the lookup indexes. */
export function deserializeMap(serialized: SerializedPermissionMap): PermissionMap {
  const roles: MappedRole[] = serialized.roles.map((role) => ({
    id: BigInt(role.id),
    name: role.name,
    guardName: role.guardName,
    permissionIds: role.permissionIds.map(BigInt),
  }));

  const permissions: MappedPermission[] = serialized.permissions.map((permission) => ({
    id: BigInt(permission.id),
    name: permission.name,
    guardName: permission.guardName,
  }));

  return buildMap(roles, permissions);
}

/** Assemble a map and its indexes from freshly-read rows. */
export function buildMap(roles: MappedRole[], permissions: MappedPermission[]): PermissionMap {
  const roleByName = new Map<string, MappedRole>();
  const roleById = new Map<bigint, MappedRole>();
  const permissionByName = new Map<string, MappedPermission>();
  const permissionById = new Map<bigint, MappedPermission>();

  for (const role of roles) {
    roleByName.set(mapKey(role.guardName, role.name), role);
    roleById.set(role.id, role);
  }

  for (const permission of permissions) {
    permissionByName.set(mapKey(permission.guardName, permission.name), permission);
    permissionById.set(permission.id, permission);
  }

  return { roles, permissions, roleByName, permissionByName, roleById, permissionById };
}
