/** How deep a nested payload is walked before masking gives up. */
const MAX_DEPTH = 8;

/**
 * The set of attribute names whose values must never be recorded, for one
 * model.
 *
 * Three sources, unioned, with one inversion:
 *
 * 1. The model's own `hidden`. A model declaring `hidden: ["password"]`
 *    has already said that attribute does not leave the application;
 *    honouring it is not a feature, it is the absence of a bug.
 * 2. The global `config.mask`.
 * 3. The per-model `resources[alias].mask`.
 *
 * `visible` inverts rule 1, exactly as `toJSON()` does: when it is
 * non-empty, `hidden` is not consulted at all and only the listed
 * attributes are serialisable. Mirroring that here means a model using
 * `visible` cannot leak through a package that only checked `hidden`.
 * Returning `null` signals "no allowlist"; a non-null set is the allowed
 * names.
 */
export interface MaskRules {
  /** Names to replace. Lowercased. */
  masked: ReadonlySet<string>;
  /** When non-null, the ONLY names that may be captured. Lowercased. */
  allowed: ReadonlySet<string> | null;
}

export interface ModelMaskSource {
  hidden?: readonly string[];
  visible?: readonly string[];
}

export function maskRulesFor(
  model: ModelMaskSource,
  globalMask: ReadonlySet<string>,
  resourceMask: ReadonlySet<string>,
): MaskRules {
  const visible = model.visible ?? [];
  const masked = new Set<string>([...globalMask, ...resourceMask]);

  if (visible.length > 0) {
    return { masked, allowed: new Set(visible.map((name) => name.toLowerCase())) };
  }

  for (const name of model.hidden ?? []) {
    masked.add(name.toLowerCase());
  }

  return { masked, allowed: null };
}

/** Whether an attribute may be captured at all, after `only`/`except`. */
export function isCapturable(
  name: string,
  rules: MaskRules,
  only: ReadonlySet<string> | null,
  except: ReadonlySet<string>,
): boolean {
  const key = name.toLowerCase();

  if (except.has(key)) {
    return false;
  }

  if (only !== null && !only.has(key)) {
    return false;
  }

  return rules.allowed === null || rules.allowed.has(key);
}

/**
 * Replace masked values anywhere in a payload, to a bounded depth.
 *
 * A masked attribute is PRESENT WITH ITS VALUE REPLACED, never omitted.
 * Omitting it would make "this field changed" unknowable, which is
 * precisely what an audit wants to know about a password column.
 *
 * The walk is recursive because a `json`-cast column holding
 * `{ api_key: "..." }` is the common case and a top-level-only match
 * would miss it. Arrays are walked element-wise.
 *
 * Two bounds, both deliberate. `MAX_DEPTH` stops a pathological structure
 * from costing unbounded work on a write path, and a `WeakSet` catches
 * cycles — an object graph with a back-reference would otherwise recurse
 * until the stack blew, turning a log write into an outage.
 */
export function maskValue(
  value: unknown,
  masked: ReadonlySet<string>,
  maskWith: string,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[circular]";
  }

  if (depth >= MAX_DEPTH) {
    return "[truncated]";
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => maskValue(entry, masked, maskWith, depth + 1, seen));
  }

  // Dates, DateTimes and other class instances are values, not bags of
  // attributes to walk: recursing into one would expose its internals as
  // though they were data the application chose to record.
  if (!isPlainObject(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    out[key] = masked.has(key.toLowerCase())
      ? maskWith
      : maskValue(entry, masked, maskWith, depth + 1, seen);
  }

  return out;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value) as object | null;

  return proto === Object.prototype || proto === null;
}
