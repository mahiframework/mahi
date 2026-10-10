import { Permission } from "./permission.model.js";
import { Role } from "./role.model.js";

/**
 * The model classes this package reads and writes through.
 *
 * One mutable object rather than direct imports, so an application can
 * point the `roles` and `permissions` tables at its own subclasses and
 * have the PACKAGE's own queries produce them — needed when a subclass
 * adds a `NOT NULL` column the package has to populate, or carries a
 * global scope that must apply to the package's reads too. Same
 * mechanism and same reasoning as `@mahiframework/media`'s registry.
 * See `docs/extending-models`.
 */
export interface PermissionModels {
  role: typeof Role;
  permission: typeof Permission;
}

export const permissionModels: PermissionModels = {
  role: Role,
  permission: Permission,
};

/**
 * Point the `roles`/`permissions` tables at application subclasses.
 *
 * Call this before `app.bootstrap()`, from a service provider's
 * `register()`. Calling it later is not wrong so much as partial:
 * anything already read through the old class stays an instance of it,
 * and the cached role map is built from whichever class was current.
 *
 *   export class AppRole extends Role {
 *     get label(): string {
 *       return Str.headline(this.name);
 *     }
 *   }
 *
 *   usePermissionModels({ role: AppRole });
 *
 * Typed `typeof Role`/`typeof Permission`, not `AnyModelClass`.
 * `AnyModelClass` is `typeof BaseModel`, which carries no attribute
 * type, so every static on it degrades to `any` and the package would
 * lose column checking on its own tables — `create({ utter: "nonsense" })`
 * would compile. The concrete types keep those errors and additionally
 * make "must be a subclass" a compile-time guarantee.
 *
 * NOT a way to change the table names. Both classes declare their table
 * and the migration creates it; a subclass pointing at a different one
 * would leave the migration having built tables nothing reads.
 */
export function usePermissionModels(overrides: Partial<PermissionModels>): void {
  Object.assign(permissionModels, overrides);
}

/**
 * Restore the package's own classes.
 *
 * The registry is module-global rather than container-bound, so a test
 * that overrode either class would leak into the next file.
 */
export function resetPermissionModels(): void {
  permissionModels.role = Role;
  permissionModels.permission = Permission;
}
