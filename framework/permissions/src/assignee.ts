import { BaseModel } from "@mahiframework/database";
import { UnsupportedAssigneeKeyError } from "./errors.js";
import type { AssigneeKeyType } from "./permissions-config.js";

/**
 * Anything that can hold a role or a permission.
 *
 * Either a model instance (the ordinary case: a `User` from
 * `Auth.user()`), or an explicit `{ type, id }` descriptor. The explicit
 * form is not a convenience — it is what lets a queue job or a CLI
 * command assign a role without hydrating a model, and what lets a
 * caller name a subject whose class isn't loaded.
 *
 * Deliberately NOT a plain `Record` with an `id`: a bare attributes
 * object carries no `morphAlias()`, so the discriminant would have to be
 * guessed. A row that came back from `Auth.user()` IS a hydrated model
 * instance in this framework, so the common path still takes the first
 * form.
 */
export type Assignee = BaseModel | AssigneeRef;

/** A subject named without a model instance: `{ type: "User", id: 123n }`. */
export interface AssigneeRef {
  /** The morph alias, i.e. whatever `Model.morphAlias()` returns for the class. */
  type: string;
  /**
   * The subject's primary key.
   *
   * A `bigint` under the default `assigneeKey: "bigint"`, a `string`
   * under `"uuid"`. The union is the config being expressible in a type;
   * `resolveAssignee()` rejects whichever one the install is not
   * configured for.
   */
  id: AssigneeKey;
}

/** A role-holder's primary key, in either of the two supported shapes. */
export type AssigneeKey = bigint | string;

/** A resolved subject, the shape every pivot read and write actually uses. */
export interface ResolvedAssignee {
  morphType: string;
  key: AssigneeKey;
}

/**
 * Narrow an `Assignee` to the `(model_type, model_id)` pair the pivots
 * store.
 *
 * THE KEY'S TYPE MUST MATCH THE COLUMN'S. `model_has_roles.model_id` is
 * a `bigInteger` or a `uuid` depending on `permissions.assigneeKey`, and
 * the pivot query binds the local key RAW, so a mismatch is checked here
 * rather than at the database — the two engines disagree about how badly
 * it goes. Postgres raises `operator does not exist: bigint = character
 * varying`, a 500 that names no model; SQLite happily stores the wrong
 * thing and then never matches it, which is a permission check silently
 * returning false forever.
 *
 * Under `"bigint"`, a `number` is rejected as well as a string: a 64-bit
 * id does not survive the round trip through one.
 *
 * Under `"uuid"`, any non-empty string is accepted. The format is NOT
 * validated — `uuid` columns reject a malformed value themselves on
 * Postgres, and an app keyed on ULIDs in a `uuid` column is doing
 * something deliberate that this guard has no business second-guessing.
 *
 * `morphAlias()` resolves through a `Relation.morphMap()` entry, then
 * `static morphName`, then the TABLE NAME. That last fallback is why the
 * docs recommend `Relation.enforceMorphMap()`: without a map, renaming a
 * table silently orphans every assignment row that named it.
 */
export function resolveAssignee(
  assignee: Assignee,
  keyType: AssigneeKeyType = "bigint",
): ResolvedAssignee {
  if (assignee instanceof BaseModel) {
    const modelClass = assignee.constructor as typeof BaseModel;
    const key = assignee.getRawAttribute(modelClass.primaryKeyColumn) as unknown;
    const morphType = modelClass.morphAlias();

    return { morphType, key: requireKey(morphType, key, keyType) };
  }

  return { morphType: assignee.type, key: requireKey(assignee.type, assignee.id, keyType) };
}

function requireKey(morphType: string, key: unknown, keyType: AssigneeKeyType): AssigneeKey {
  if (keyType === "uuid") {
    if (typeof key !== "string" || key === "") {
      throw new UnsupportedAssigneeKeyError(morphType, key, keyType);
    }

    return key;
  }

  if (typeof key !== "bigint") {
    throw new UnsupportedAssigneeKeyError(morphType, key, keyType);
  }

  return key;
}

/**
 * A stable string for one subject, used only as a per-request memo key.
 *
 * Never stored. The separator is `:` and both halves are already
 * constrained (a morph alias is an identifier, a key is digits or a
 * uuid, neither of which contains a colon), so no escaping is needed to
 * keep two different subjects from colliding.
 */
export function assigneeCacheKey(assignee: ResolvedAssignee): string {
  return `${assignee.morphType}:${assignee.key}`;
}
