export { PermissionsServiceProvider, PERMISSIONS_TOKEN } from "./permissions-service-provider.js";
export { Permissions } from "./permissions-facade.js";
export { PermissionRegistrar } from "./permission-registrar.js";
export type { GuardOption, RoleRef, PermissionRef } from "./permission-registrar.js";

export { Role } from "./models/role.model.js";
export type { RoleAttributes } from "./models/role.model.js";
export { Permission } from "./models/permission.model.js";
export type { PermissionAttributes } from "./models/permission.model.js";

export { rolesRelation, permissionsRelation } from "./relations.js";

export { resolveAssignee, assigneeCacheKey } from "./assignee.js";
export type { Assignee, AssigneeRef, ResolvedAssignee } from "./assignee.js";

export { resolveConfig } from "./permissions-config.js";
export type {
  PermissionsConfig,
  PermissionsCacheConfig,
  ResolvedPermissionsConfig,
} from "./permissions-config.js";

export { role } from "./middleware/role.js";
export { permission } from "./middleware/permission.js";
export { roleOrPermission } from "./middleware/role-or-permission.js";
export type { RoleOrPermissionOptions } from "./middleware/role-or-permission.js";

export { withPermissionCache } from "./request-cache.js";

export { InvalidatePermissionCacheListener } from "./listeners/invalidate-permission-cache.listener.js";

export { PermissionsCacheResetCommand } from "./commands/permissions-cache-reset.js";
export { PermissionsCheckCommand } from "./commands/permissions-check.js";
export { PermissionsShowCommand } from "./commands/permissions-show.js";

// The map's types are exported, its functions are not: an app may want to
// describe what it read off `registrar.map()`, but `serializeMap`/
// `deserializeMap` are the cache boundary and have no caller outside it.
export type {
  PermissionMap,
  MappedRole,
  MappedPermission,
  SerializedPermissionMap,
} from "./permission-map.js";

export {
  PermissionsError,
  RoleNotFoundError,
  PermissionNotFoundError,
  DuplicateNameError,
  UnsupportedAssigneeKeyError,
  UnresolvedGuardError,
  UnknownMorphAliasError,
} from "./errors.js";
