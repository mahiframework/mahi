import { ServiceProvider } from "@mahiframework/core";
import type { AnyModelClass, RegisteredMigration } from "@mahiframework/database";
import { BaseModel, ModelCreated, ModelDeleted, ModelUpdated } from "@mahiframework/database";
import type { GateRegistry } from "@mahiframework/authorization";
import type { ListenerRegistration } from "@mahiframework/events";
import type { HttpPipe } from "@mahiframework/http";
import { PermissionRegistrar } from "./permission-registrar.js";
import { resolveConfig, type PermissionsConfig } from "./permissions-config.js";
import { permissionModels } from "./models/registry.js";
import { InvalidatePermissionCacheListener } from "./listeners/invalidate-permission-cache.listener.js";
import { PermissionsCacheResetCommand } from "./commands/permissions-cache-reset.js";
import { PermissionsCheckCommand } from "./commands/permissions-check.js";
import { PermissionsShowCommand } from "./commands/permissions-show.js";
import createPermissionTables from "./migrations/0001_create_permission_tables.js";
import { runWithPermissionCache } from "./request-cache.js";
import { PERMISSIONS_TOKEN } from "./tokens.js";

export { PERMISSIONS_TOKEN };

/**
 * Registers the `PermissionRegistrar` singleton, the gate hook that makes
 * `can()` consult permissions, the per-request assignment memo, and the
 * listeners that keep the cache honest.
 *
 * ORDERING: list this provider AFTER `DatabaseServiceProvider` (it owns
 * five tables and two models), AFTER `CacheServiceProvider` (the map
 * lives in a cache store), AFTER `AuthServiceProvider` (so its memo pipe
 * runs inside the ambient auth scope and the subject is resolvable), and
 * BEFORE `HttpServiceProvider` (so its pipe is collected before routes
 * are). `AuthorizationServiceProvider` may come on either side:
 * its own `boot()` walks every registered provider, so `gates()` is
 * collected whichever order they appear in. You cannot enforce any of
 * that; the app's `config/app.ts` decides, and this docstring is the
 * whole mechanism.
 */
export class PermissionsServiceProvider extends ServiceProvider {
  register(): void {
    // No `config.merge()` of defaults. Every default is applied in
    // `resolveConfig()` with `??`, which is both the single place to read
    // them and immune to merge-order surprises: `ConfigRepository.merge()`
    // deep-merges the INCOMING values last, so contributing defaults that
    // way would silently overwrite the app's own config rather than
    // layering under it.
    this.app.singleton(PERMISSIONS_TOKEN, (app) => {
      // `get`, not `require`: an app that installs the package and
      // configures nothing gets working defaults (the auth default
      // guard, a day-long cache) rather than a boot failure.
      const config = app.config.get<PermissionsConfig>("permissions") ?? {};

      return new PermissionRegistrar(app, resolveConfig(config));
    });
  }

  /**
   * Teach the gate that a bare ability may be a permission name.
   *
   * This is what makes `can("posts.edit")`, `Gate.authorize("posts.edit")`
   * and the `can()` route middleware consult permissions without any of
   * them knowing this package exists. spatie registers the same hook.
   *
   * THREE THINGS HERE ARE LOAD-BEARING:
   *
   * 1. It returns `true` or `null`, NEVER `false`. A `false` from a
   *    `before()` hook hard-denies and skips policy resolution entirely,
   *    so denying on a permission miss would make every policy in the app
   *    unreachable — the single worst bug this package could ship, and
   *    the reason there is a test asserting a policy still grants after a
   *    miss.
   *
   * 2. It abstains the moment the check carries an argument
   *    (`args.length > 0`), which is a DELIBERATE DIVERGENCE FROM SPATIE.
   *    There, `Gate::allows("update", $post)` also routes through the
   *    permission check, so an app with both a permission named `update`
   *    and a `PostPolicy.update` grants update on EVERY post to anyone
   *    holding that permission. Abstaining splits the two cleanly: bare
   *    abilities are permission names, model-scoped abilities are the
   *    policy's business, and a policy that wants a permission check calls
   *    `Permissions.hasPermissionTo()` explicitly — which is where that
   *    decision belongs anyway, next to the row it concerns.
   *
   * 3. A non-model user abstains too. The pivots need a morph alias and
   *    a key of the configured type; a token-guard adapter or a plain
   *    object has neither, and `resolveAssignee()` would throw. A hook
   *    that throws turns every authorization check in the app into a
   *    500. Note that a model whose key is the WRONG type still throws —
   *    deliberately, since that is a misconfiguration the app has to
   *    fix rather than a subject that merely holds no permissions.
   *
   * `gates()` is synchronous, so nothing is loaded here. The closure is
   * async and the first check of the process populates the cache.
   *
   * Hooks run in registration order and the first non-null wins, so a
   * permission grant beats a later hook that would have denied. That
   * ordering is the app's `config/app.ts` choice.
   */
  gates(gate: GateRegistry): void {
    const config = resolveConfig(this.app.config.get<PermissionsConfig>("permissions") ?? {});

    if (!config.gate) {
      return;
    }

    gate.before(async (user, ability, ...args) => {
      if (args.length > 0 || !(user instanceof BaseModel)) {
        return null;
      }

      const registrar = this.app.make<PermissionRegistrar>(PERMISSIONS_TOKEN);

      return (await registrar.hasPermissionTo(user, ability)) ? true : null;
    });
  }

  /**
   * Open a per-request assignment memo.
   *
   * Not an optimisation so much as a correction: the gate hook above runs
   * on EVERY authorization check, so a controller making five `can()`
   * calls would be ten queries without this. See `request-cache.ts`.
   */
  middleware(): HttpPipe[] {
    return [(request, next) => runWithPermissionCache(() => next(request))];
  }

  /**
   * Forget the cached map when a `Role` or `Permission` is written
   * outside the registrar — a seeder, a migration, an admin screen.
   * See the listener for why these three events and not a pattern.
   */
  listeners(): ReadonlyArray<ListenerRegistration> {
    return [
      [ModelCreated, InvalidatePermissionCacheListener],
      [ModelUpdated, InvalidatePermissionCacheListener],
      [ModelDeleted, InvalidatePermissionCacheListener],
    ] as const;
  }

  /**
   * Static rather than a `migrations()` directory path, so it resolves
   * inside a bundled binary. One migration for all five tables; see the
   * file for why they are not five.
   */
  migrationSources(): RegisteredMigration[] {
    return [{ name: "0001_create_permission_tables", migration: createPermissionTables }];
  }

  /**
   * Registered so a queued job can carry a `Role` or a `Permission`.
   *
   * Read through the registry, so an app that called
   * `usePermissionModels()` has ITS classes registered rather than the
   * package's — a job carrying an `AppRole` would otherwise fail to
   * resolve at dispatch.
   */
  models(): AnyModelClass[] {
    return [
      permissionModels.role as unknown as AnyModelClass,
      permissionModels.permission as unknown as AnyModelClass,
    ];
  }

  commands() {
    return [PermissionsCacheResetCommand, PermissionsCheckCommand, PermissionsShowCommand];
  }
}
