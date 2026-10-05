import { Model, belongsToMany, type BelongsToMany } from "@mahiframework/database";
import { snowflake } from "@mahiframework/snowflake";
import type { DateTime } from "@mahiframework/datetime";
import { Role } from "./role.model.js";

/**
 * A single named thing a subject may do: `"posts.edit"`, `"billing.view"`.
 *
 * A permission is a *name*, not a rule. It carries no model class, no
 * row, no callback — holding `"posts.edit"` says nothing about *which*
 * post. That is the Gate's job, and the deliberate reason this package's
 * gate hook abstains the moment a check carries a model argument (see
 * `PermissionsServiceProvider.gates()`).
 *
 * `guard_name` scopes the permission to one of the app's auth guards, so
 * an `api`-guard permission cannot satisfy a `web`-guard check. It is NOT
 * NULL and has no wildcard value: `(name, guard_name)` is unique, and a
 * nullable column cannot be made unique portably (`nullsNotDistinct` is
 * Postgres 15+ only and throws on SQLite/MySQL), so "applies to every
 * guard" would have meant unlimited duplicate rows in dev.
 */
export interface PermissionAttributes {
  /** A snowflake, hence `bigint`: a 64-bit id does not fit a `number`. */
  id: bigint;
  name: string;
  /** The auth guard this permission belongs to, e.g. `"web"`. Never null. */
  guard_name: string;
  created_at: DateTime;
  updated_at: DateTime;
  /** Roles granting this permission, across `role_has_permissions`. */
  roles: BelongsToMany<Role>;
}

export class Permission extends Model<PermissionAttributes>()({
  table: "permissions",
  primaryKey: "id",
  keyType: snowflake(),
  morphName: "Permission",
}) {
  static override relationships = {
    roles: belongsToMany(() => Role, {
      pivotTable: "role_has_permissions",
      foreignPivotKey: "permission_id",
      relatedPivotKey: "role_id",
    }),
  };
}
