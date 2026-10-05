import { resolveAccept, type MediaAcceptConfig, type ResolvedAccept } from "../media-config.js";
import type { MediaModifier } from "../pipeline/modifier.js";

/**
 * How one media relation is configured.
 *
 * IMMUTABLE. Every fluent method returns a new blueprint rather than
 * mutating, which is the one place this design deliberately departs from
 * laravel-media. There, `makeMediaAdder()` hands the relation's own
 * blueprint object to the adder by reference, so a per-call override
 * leaks into every later call on the same relation — behaviour its test
 * suite pins with an explicit "shares blueprint configuration across
 * instances" case. Cloning makes
 *
 *   await user.photos().accept({ extensions: ["jpg"] }).add(file);
 *
 * mean "for this call", which is what every reader expects it to mean.
 */
export interface MediaBlueprint {
  readonly collection: string | null;
  readonly disk: string | null;
  readonly path: string | null;
  readonly filename: string | null;
  readonly accept: ResolvedAccept | null;
  readonly keepLatest: number | null;
  readonly modifiers: readonly MediaModifier[];
  readonly customProperties: Record<string, unknown> | null;
}

export const EMPTY_BLUEPRINT: MediaBlueprint = {
  collection: null,
  disk: null,
  path: null,
  filename: null,
  accept: null,
  keepLatest: null,
  modifiers: [],
  customProperties: null,
};

/** Apply a change, returning a new blueprint. */
export function withBlueprint(
  blueprint: MediaBlueprint,
  change: Partial<MediaBlueprint>,
): MediaBlueprint {
  return { ...blueprint, ...change };
}

/**
 * Combine a relation's accept rules with the app-wide floor.
 *
 * NARROWING ONLY, never widening. A collection may refuse more than
 * `config.media.accept` does but never less: an app that caps uploads at
 * 5MB has made a decision about its disk and its bandwidth, and a
 * relation should not be able to opt out of it.
 *
 * So `maxBytes` takes the smaller of the two, and the type lists
 * intersect when both are present — a relation listing `["png", "pdf"]`
 * under an app-wide `["png", "jpg"]` ends up with `["png"]`, which is
 * the only reading consistent with both.
 */
export function narrowAccept(
  floor: ResolvedAccept,
  relation: ResolvedAccept | null,
): ResolvedAccept {
  if (relation === null) {
    return floor;
  }

  return {
    mimes: intersect(floor.mimes, relation.mimes),
    extensions: intersect(floor.extensions, relation.extensions),
    maxBytes: smallest(floor.maxBytes, relation.maxBytes),
  };
}

/**
 * Intersect two constraint lists, treating empty as "no constraint".
 *
 * An empty list means unconstrained, so intersecting with one yields the
 * other — not the empty set, which would mean "nothing is allowed" and
 * reject every upload.
 */
function intersect(floor: readonly string[], relation: readonly string[]): readonly string[] {
  if (floor.length === 0) {
    return relation;
  }

  if (relation.length === 0) {
    return floor;
  }

  const allowed = relation.filter((entry) => floor.includes(entry));

  // An empty intersection is a genuine contradiction — the relation asked
  // for types the app forbids. Keeping the floor is the safe reading;
  // returning `[]` would mean "unconstrained" and allow everything.
  return allowed.length === 0 ? floor : allowed;
}

function smallest(floor: number | null, relation: number | null): number | null {
  if (floor === null) {
    return relation;
  }

  if (relation === null) {
    return floor;
  }

  return Math.min(floor, relation);
}

export { resolveAccept };
export type { MediaAcceptConfig, ResolvedAccept };
