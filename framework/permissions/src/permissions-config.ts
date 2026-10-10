import { app } from "@mahiframework/core";

/**
 * The optional `"permissions"` config namespace.
 *
 * Every field has a default, so an app that never writes
 * `config/permissions.ts` gets a working package: roles scoped to the
 * app's default auth guard, a day-long cache in the default store, and
 * the gate hook registered.
 *
 * NOTHING HERE IMPORTS A MODEL. A `config/*.ts` is loaded before
 * `app.bootstrap()`, so importing a model would pull the ORM into
 * config-load time.
 */
/**
 * How a role-holder's primary key is stored in the assignment pivots.
 *
 * Two values rather than a free-form column type, because the pivot's
 * `model_id` is bound RAW into the local side of a `morphToMany` query
 * and so has to match the key's runtime type exactly. `"bigint"` means
 * a `bigInteger` column and a `bigint` key; `"uuid"` means a `uuid`
 * column and a `string` key. Anything else — a `text` column holding
 * whatever — would need the query builder to cast on every pivot read,
 * which is what the migration's own docstring records as the reason to
 * avoid it.
 */
export type AssigneeKeyType = "bigint" | "uuid";

export interface PermissionsConfig {
  /**
   * The guard name stamped on new roles and permissions, and used by any
   * check that doesn't name one.
   *
   * Defaults to `auth.default`, which is what a single-guard app wants
   * and never has to think about. A multi-guard app that wants `api`
   * roles passes `{ guard: "api" }` per call; this is only the fallback.
   *
   * There is no wildcard guard. See the migration for why the column
   * cannot be nullable.
   */
  guard?: string;

  cache?: PermissionsCacheConfig;

  /**
   * The key type of the models that hold roles and permissions.
   * Defaults to `"bigint"`.
   *
   *   { assigneeKey: "bigint" }   // model_id is a bigInteger
   *   { assigneeKey: "uuid" }     // model_id is a uuid, keys are strings
   *
   * Read by BOTH the migration — which chooses `bigInteger` or `uuid`
   * for `model_has_roles.model_id` and
   * `model_has_permissions.model_id` — and `resolveAssignee()`, which
   * rejects a key of the wrong type before it reaches SQL. They have to
   * move together: a guard that kept expecting a `bigint` would reject
   * exactly what the column now accepts.
   *
   * `uuid` for an app that took `docs/models`' advice and keyed its
   * `User` on `uuidv7`. Without it the package is unusable there, and
   * the workaround is keying one table on `bigint` because an unrelated
   * package said so.
   *
   * `role_id` and `permission_id` stay `bigInteger` either way: they
   * reference this package's own tables, whose keys it assigns, and the
   * app's choice has nothing to say about them.
   *
   * 🚨 ONLY SAFE BEFORE THE FIRST MIGRATION RUNS. Changing it on an
   * install that already has assignment rows does not re-interpret
   * them — the column type is set and the rows are written.
   * `permissions:check` detects the mismatch and exits non-zero.
   */
  assigneeKey?: AssigneeKeyType;

  /**
   * Register the `Gate.before()` hook that makes `can("posts.edit")`
   * consult permissions.
   *
   * On by default: it is the headline integration, and an app that
   * installs this package and then finds `can()` ignores it has been
   * surprised in the expensive direction. Set `false` to check only
   * through this package's own API and middleware.
   */
  gate?: boolean;
}

export interface PermissionsCacheConfig {
  /**
   * The single key holding the whole role/permission map.
   *
   * One key, not one per entity, because `@mahiframework/cache` has no
   * tags: there is no way to flush by pattern, so every key this package
   * writes is a key it must be able to name later. One is nameable.
   */
  key?: string;

  /** A named cache store, else the default one. */
  store?: string;

  /**
   * How long the map survives, in seconds. Defaults to 24 hours.
   *
   * A TTL rather than no-expiry specifically BECAUSE there are no cache
   * tags. Invalidation here is explicit `forget()` on write plus model-
   * event listeners, and if some path ever escapes both, a `null` TTL
   * would make the stale map permanent. A day is short enough that a
   * missed invalidation is an incident with an end, and long enough that
   * the map is effectively always warm.
   */
  ttlSeconds?: number;
}

/** The config with every default applied, built once at provider boot. */
export interface ResolvedPermissionsConfig {
  /** Null when neither config nor `auth.default` named one; resolved lazily so boot doesn't fail. */
  guard: string | null;
  cacheKey: string;
  cacheStore: string | undefined;
  cacheTtlSeconds: number;
  assigneeKey: AssigneeKeyType;
  gate: boolean;
}

const DEFAULT_CACHE_KEY = "mahi.permissions";
const DEFAULT_TTL_SECONDS = 86_400;

/**
 * Normalise a config block once, at provider boot.
 *
 * Every default is applied here with `??`, which is both the single place
 * to read them and immune to merge-order surprises: contributing them via
 * `ConfigRepository.merge()` would deep-merge the INCOMING values last
 * and silently overwrite the app's own config rather than layering under
 * it.
 */
export function resolveConfig(config: PermissionsConfig = {}): ResolvedPermissionsConfig {
  const cache = config.cache ?? {};

  return {
    guard: config.guard ?? null,
    cacheKey: cache.key ?? DEFAULT_CACHE_KEY,
    cacheStore: cache.store,
    cacheTtlSeconds: cache.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    assigneeKey: config.assigneeKey ?? "bigint",
    gate: config.gate ?? true,
  };
}

/**
 * The configured assignee key type, read from the current application.
 *
 * A function rather than a value because the migration needs it and a
 * migration has no injected `app` — it is a bare `{ up, down }` module,
 * run by the migrator. Defaults to `"bigint"` when there is no
 * application at all, which is the case for a migration being linted or
 * inspected rather than run.
 */
export function configuredAssigneeKey(): AssigneeKeyType {
  let config: PermissionsConfig | undefined;

  try {
    config = app().config.get<PermissionsConfig>("permissions");
  } catch {
    // No application is current. A migration cannot run in that state,
    // so this is an inspection; the default is the honest answer.
    return "bigint";
  }

  return config?.assigneeKey ?? "bigint";
}
