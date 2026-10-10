import { morphToMany } from "@mahiframework/database";
import { permissionModels } from "./models/registry.js";

/**
 * The `roles` relation, for an app model that wants to eager-load them.
 *
 * Opt-in per model rather than shipped on anything, because the package
 * owns neither the app's models nor its attribute interfaces:
 *
 *   export interface UserAttributes {
 *     // ...
 *     roles: MorphToMany<Role>;
 *   }
 *
 *   export class User extends Model<UserAttributes>()({ ... }) {
 *     static override relationships = {
 *       roles: rolesRelation(),
 *     };
 *   }
 *
 * That buys `User.query().with("roles.permissions")` and
 * `whereHas("roles", (q) => q.where("name", "admin"))`.
 *
 * READ-ONLY, in practice. `Permissions.assignRole()` writes the pivot
 * directly (it takes a subject, not a relation handle, so it can also
 * work from a `{ type, id }` descriptor in a job), so a collection
 * loaded by `with("roles")` will not reflect an assignment made later in
 * the same request. Re-`load()` it if that matters.
 *
 * `type` is deliberately omitted so it defaults to the DECLARING model's
 * `morphAlias()` — which is what a `morphToMany` wants, and the opposite
 * of what `morphedByMany` would. Note that `morphAlias()` falls back to
 * the table name, so an app without a `Relation.morphMap()` entry has
 * made its assignment rows depend on its table name.
 *
 * Resolves `permissionModels.role` inside the thunk rather than closing
 * over the class, so an app that calls `usePermissionModels()` from a
 * provider's `register()` gets its subclass here too — the relation is
 * declared as a `static relationships` field and so is built at class
 * definition time, which is before any provider has run.
 */
export function rolesRelation() {
  return morphToMany(() => permissionModels.role, {
    pivotTable: "model_has_roles",
    morphType: "model_type",
    morphId: "model_id",
    relatedPivotKey: "role_id",
  });
}

/**
 * The `permissions` relation: permissions granted to this model
 * DIRECTLY, never those inherited from its roles.
 *
 * The inherited ones have no relation to declare — they are two hops
 * through `model_has_roles` and `role_has_permissions`, which is a
 * `hasManyThrough` the ORM cannot express across a polymorphic pivot.
 * `Permissions.getAllPermissions(user)` is the union, and it answers
 * from the cached map rather than a join.
 */
export function permissionsRelation() {
  return morphToMany(() => permissionModels.permission, {
    pivotTable: "model_has_permissions",
    morphType: "model_type",
    morphId: "model_id",
    relatedPivotKey: "permission_id",
  });
}
