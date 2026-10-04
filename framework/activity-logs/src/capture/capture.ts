import type { ResolvedResource } from "../activity-log-config.js";
import { isCapturable, maskValue, type MaskRules } from "./mask.js";

/**
 * What a model instance has to expose to be captured.
 *
 * Structural rather than importing `Model`, for two reasons. The payload
 * of a `ModelLifecycleEvent` is typed `ModelEventPayload`, which is
 * `TModel | Record<string, any>` — the static `Model.update(id, values)`
 * path hands over a plain object, not an instance. And capture is a pure
 * function worth testing without an ORM.
 */
export interface CapturableModel {
  toObject?(): Record<string, unknown>;
  getChanges?(): Record<string, unknown>;
  getOriginal?(key: string): unknown;
}

/** Whether a payload is a real model instance or the plain-object fallback. */
export function isModelInstance(payload: unknown): payload is Required<CapturableModel> {
  const candidate = payload as CapturableModel | null;

  return (
    candidate !== null &&
    typeof candidate === "object" &&
    typeof candidate.getChanges === "function" &&
    typeof candidate.toObject === "function"
  );
}

/**
 * The payload for a create (and for a restore, which has the same shape).
 *
 * Reads `toObject()` rather than `getChanges()`: the insert branch of
 * `save()` sets `state.changes = {}` and calls `syncOriginal()` BEFORE
 * dispatching `created`, so `getChanges()` is empty after a create.
 * Nothing changed, a row came into being.
 */
export function captureAttributes(
  model: CapturableModel,
  resource: ResolvedResource,
  rules: MaskRules,
  maskWith: string,
): Record<string, unknown> | null {
  if (resource.capture === "none") {
    return null;
  }

  const attributes = model.toObject?.() ?? {};
  const names = Object.keys(attributes).filter((name) =>
    isCapturable(name, rules, resource.only, resource.except),
  );

  if (resource.capture === "columns") {
    return { attributes: names };
  }

  const values: Record<string, unknown> = {};

  for (const name of names) {
    values[name] = rules.masked.has(name.toLowerCase())
      ? maskWith
      : maskValue(attributes[name], rules.masked, maskWith);
  }

  return { attributes: values };
}

/**
 * The from→to payload for an update.
 *
 * ONLY CORRECT INSIDE THE `updated` EVENT. `save()` calls `syncChanges()`
 * before dispatching and `syncOriginal()` after, so for the duration of
 * the dispatch `getChanges()` holds what was written and
 * `getOriginal(key)` still holds the pre-write value. Reading either one
 * later — from a queued listener, from an `afterDispatch` callback — finds
 * `original` already overwritten, and could only report the new state.
 * This is the single reason the whole package writes in-band.
 */
export function captureChanges(
  model: Required<CapturableModel>,
  resource: ResolvedResource,
  rules: MaskRules,
  maskWith: string,
): Record<string, unknown> | null {
  if (resource.capture === "none") {
    return null;
  }

  const changed = Object.keys(model.getChanges()).filter((name) =>
    isCapturable(name, rules, resource.only, resource.except),
  );

  if (resource.capture === "columns") {
    return { changed };
  }

  const changes: Record<string, unknown> = {};

  for (const name of changed) {
    const masked = rules.masked.has(name.toLowerCase());

    changes[name] = masked
      ? { from: maskWith, to: maskWith }
      : {
          from: maskValue(model.getOriginal(name), rules.masked, maskWith),
          to: maskValue(model.getChanges()[name], rules.masked, maskWith),
        };
  }

  return { changes };
}

/**
 * The degraded payload for `Model.update(id, values)`.
 *
 * That static fires `updated` with a plain cast-attributes object rather
 * than an instance, so there is no `getOriginal()` to read a from-value
 * out of and no `hidden` to honour. Column names only, REGARDLESS of the
 * configured capture mode: `full` cannot be satisfied, and silently
 * emitting a one-sided "change" would misrepresent it as a from→to pair.
 *
 * Not a corner case — the scaffolded `LoginController` uses this path to
 * rehash a password on login.
 */
export function capturePlainUpdate(
  payload: Record<string, unknown>,
  resource: ResolvedResource,
  rules: MaskRules,
  primaryKey: string,
): Record<string, unknown> | null {
  if (resource.capture === "none") {
    return null;
  }

  const changed = Object.keys(payload).filter(
    (name) => name !== primaryKey && isCapturable(name, rules, resource.only, resource.except),
  );

  return { changed, partial: true };
}
