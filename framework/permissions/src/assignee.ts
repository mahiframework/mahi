import { BaseModel } from "@mahiframework/database";
import { UnsupportedAssigneeKeyError } from "./errors.js";

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
  id: bigint;
}

/** A resolved subject, the shape every pivot read and write actually uses. */
export interface ResolvedAssignee {
  morphType: string;
  key: bigint;
}

/**
 * Narrow an `Assignee` to the `(model_type, model_id)` pair the pivots
 * store.
 *
 * The key MUST be a `bigint`. `model_has_roles.model_id` is a
 * `bigInteger` column (see the migration for why it can't be text), so a
 * uuid- or string-keyed model cannot hold a role. Caught here rather
 * than at the database because the two engines disagree about how badly:
 * Postgres raises `operator does not exist: bigint = character varying`,
 * a 500 that names no model, while SQLite happily stores the string and
 * then never matches it — a permission check that silently returns false
 * forever. A `number` is rejected for the same reason the snowflake
 * package returns `bigint`: a 64-bit id does not survive the round trip.
 *
 * `morphAlias()` resolves through a `Relation.morphMap()` entry, then
 * `static morphName`, then the TABLE NAME. That last fallback is why the
 * docs recommend `Relation.enforceMorphMap()`: without a map, renaming a
 * table silently orphans every assignment row that named it.
 */
export function resolveAssignee(assignee: Assignee): ResolvedAssignee {
  if (assignee instanceof BaseModel) {
    const modelClass = assignee.constructor as typeof BaseModel;
    const key = assignee.getRawAttribute(modelClass.primaryKeyColumn) as unknown;

    return { morphType: modelClass.morphAlias(), key: requireBigint(modelClass.morphAlias(), key) };
  }

  return { morphType: assignee.type, key: requireBigint(assignee.type, assignee.id) };
}

function requireBigint(morphType: string, key: unknown): bigint {
  if (typeof key !== "bigint") {
    throw new UnsupportedAssigneeKeyError(morphType, key);
  }

  return key;
}

/**
 * A stable string for one subject, used only as a per-request memo key.
 *
 * Never stored. The separator is `:` and both halves are already
 * constrained (a morph alias is an identifier, a key is digits), so no
 * escaping is needed to keep two different subjects from colliding.
 */
export function assigneeCacheKey(assignee: ResolvedAssignee): string {
  return `${assignee.morphType}:${assignee.key}`;
}
