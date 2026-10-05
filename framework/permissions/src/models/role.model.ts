import { Model, belongsToMany, type BelongsToMany } from "@mahiframework/database";
import { snowflake } from "@mahiframework/snowflake";
import type { DateTime } from "@mahiframework/datetime";
import { Permission } from "./permission.model.js";

/**
 * A named bundle of permissions a subject can hold.
 *
 * The indirection is the whole point: a subject holding `"editor"`
 * inherits every permission attached to it, so changing what an editor
 * may do is one write instead of one per user. A permission can also be
 * granted to a subject directly (`model_has_permissions`), which
 * supplements roles rather than replacing them.
 *
 * `guard_name` is NOT NULL and scoped exactly as `Permission`'s is; see
 * that model for why there is no wildcard guard.
 *
 * There is intentionally no `users` relation here. The inverse of the
 * polymorphic assignment is a `morphedByMany`, which needs the *app's*
 * model class, and this package does not know it. The docs show the three
 * lines an app writes to declare it, and flag the `type`-defaulting
 * asymmetry between `morphToMany` and `morphedByMany`.
 */
export interface RoleAttributes {
  /** A snowflake, hence `bigint`: a 64-bit id does not fit a `number`. */
  id: bigint;
  name: string;
  /** The auth guard this role belongs to, e.g. `"web"`. Never null. */
  guard_name: string;
  created_at: DateTime;
  updated_at: DateTime;
  /** Permissions this role grants, across `role_has_permissions`. */
  permissions: BelongsToMany<Permission>;
}

export class Role extends Model<RoleAttributes>()({
  table: "roles",
  primaryKey: "id",
  keyType: snowflake(),
  morphName: "Role",
}) {
  static override relationships = {
    permissions: belongsToMany(() => Permission, {
      pivotTable: "role_has_permissions",
      foreignPivotKey: "role_id",
      relatedPivotKey: "permission_id",
    }),
  };
}
