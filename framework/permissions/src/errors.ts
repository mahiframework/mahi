/**
 * Base class for every error this package throws, so an app can catch
 * the whole family in one `catch` when it would rather render a generic
 * failure than discriminate.
 */
export class PermissionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A role was looked up by name and does not exist.
 *
 * Thrown rather than returning null because every caller is a write
 * (`assignRole("admni")`) or an explicit `findRole`. A silent no-op on a
 * typo'd role name is the failure mode an authorization system can least
 * afford: it reads as "assigned" and grants nothing.
 */
export class RoleNotFoundError extends PermissionsError {
  constructor(
    readonly roleName: string,
    readonly guard: string,
  ) {
    super(`There is no role named "${roleName}" for guard "${guard}".`);
  }
}

/** A permission was looked up by name and does not exist. See `RoleNotFoundError`. */
export class PermissionNotFoundError extends PermissionsError {
  constructor(
    readonly permissionName: string,
    readonly guard: string,
  ) {
    super(`There is no permission named "${permissionName}" for guard "${guard}".`);
  }
}

/**
 * A role or permission with this name already exists for this guard.
 *
 * `(name, guard_name)` is unique in the database, so this is also a
 * `UniqueConstraintViolationException` waiting to happen; raising it by
 * name first means the message says which name, rather than which index.
 */
export class DuplicateNameError extends PermissionsError {
  constructor(
    readonly kind: "role" | "permission",
    readonly name: string,
    readonly guard: string,
  ) {
    super(`A ${kind} named "${name}" already exists for guard "${guard}".`);
  }
}

/**
 * The assignee's primary key is not a `bigint`.
 *
 * `model_has_roles.model_id` is a `bigInteger` column, so only
 * integer-keyed models can hold roles. Thrown here rather than letting
 * the value reach SQL: Postgres rejects a non-numeric string against a
 * `bigint` with `operator does not exist`, which is a 500 that says
 * nothing about why, and SQLite would accept it and simply never match.
 */
export class UnsupportedAssigneeKeyError extends PermissionsError {
  constructor(
    readonly morphType: string,
    readonly key: unknown,
  ) {
    super(
      `"${morphType}" keys on ${typeof key}, but model_has_roles.model_id is a bigInteger, ` +
        `so only integer-keyed models can hold roles or permissions. ` +
        `Assign to a model whose primary key is a bigint.`,
    );
  }
}

/**
 * No guard name could be resolved.
 *
 * Every role and permission is scoped to a guard, and the column is NOT
 * NULL with no wildcard, so there is nothing sensible to fall back to.
 * Failing here beats stamping `""` and silently creating a guard nobody
 * will ever check against.
 */
export class UnresolvedGuardError extends PermissionsError {
  constructor() {
    super(
      `No guard name could be resolved. Pass one explicitly ({ guard: "web" }), set ` +
        `\`guard\` in config/permissions.ts, or configure \`auth.default\`.`,
    );
  }
}

/**
 * An assignee's `model_type` names no registered model.
 *
 * Only raised by `permissions:check`, never during a check: a stale
 * discriminant is data, and the framework's own morph resolution treats
 * an unknown one as a dangling foreign key rather than crashing a read.
 */
export class UnknownMorphAliasError extends PermissionsError {
  constructor(readonly alias: string) {
    super(
      `"${alias}" matches no registered model. Morph aliases come from a Relation.morphMap() ` +
        `entry, a model's \`static morphName\`, or its table name.`,
    );
  }
}
