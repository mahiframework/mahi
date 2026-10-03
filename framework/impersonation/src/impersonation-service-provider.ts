import { ServiceProvider } from "@mahiframework/core";
import type { RegisteredMigration } from "@mahiframework/database";
import { authenticate } from "@mahiframework/auth";
import type { Router } from "@mahiframework/http";
import { ImpersonationManager } from "./impersonation-manager.js";
import type { ImpersonationConfig } from "./impersonation-config.js";
import { IMPERSONATION_TOKEN } from "./tokens.js";
import { StartImpersonationController } from "./http/start-impersonation.controller.js";
import { StopImpersonationController } from "./http/stop-impersonation.controller.js";
import { ImpersonationGcCommand } from "./commands/impersonation-gc.js";
import createImpersonationsTable from "./migrations/0001_create_impersonations_table.js";

export { IMPERSONATION_TOKEN };

/**
 * Binds the `ImpersonationManager`, owns the `impersonations` table, and
 * registers the start/stop routes when `impersonation.routes` is set.
 *
 * **Ordering in `config/app.ts`:** after `AuthServiceProvider` (the
 * manager resolves `AUTH_TOKEN`, and `authenticate()` on the routes needs
 * it bound) and before `HttpServiceProvider`, so the `routes()` hook is
 * collected when the kernel walks the providers. The same slot
 * `AuthorizationServiceProvider` occupies.
 *
 * Registering the provider grants nothing on its own: the gate defaults to
 * deny-all until an app calls `Impersonation.authorize(...)`.
 */
export class ImpersonationServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(IMPERSONATION_TOKEN, (app) => {
      const config = app.config.get<ImpersonationConfig>("impersonation") ?? {};

      return new ImpersonationManager(app, config);
    });
  }

  /**
   * The start/stop routes, registered only when `impersonation.routes` is
   * present. Key presence is the switch; see `ImpersonationConfig`.
   *
   * This is the framework's first use of the `routes()` provider hook,
   * which `@mahiframework/http` has always declared. `@mahiframework/health`
   * cannot use it (it has no HTTP dependency, so the kernel mounts
   * `/health` on its behalf by token) and `@mahiframework/broadcasting`
   * reaches for `kernel.rootRouter()` from `boot()` instead. Neither dodge
   * applies here: this package needs `Request` and `HttpError` regardless,
   * so it depends on the http package outright and uses the hook as
   * intended.
   */
  routes(router: Router): void {
    const config = this.app.config.get<ImpersonationConfig["routes"]>("impersonation.routes");

    if (!config) {
      return;
    }

    const parameter = config.parameter ?? "user";

    router.group(config.prefix ?? "/impersonate", (group) => {
      // MUST precede the routes. `Router.middleware()` throws when called
      // after one is registered, precisely so an `authenticate()` that
      // guards nothing is a boot failure rather than a silent hole.
      group.middleware(authenticate(config.guard));

      group.post(`/{${parameter}}`, StartImpersonationController).name("impersonation.start");

      // Named, which is only safe because these routes are opt-in:
      // `RouteRegistry.register()` throws on a duplicate name, so an app
      // that already owns "impersonation.stop" simply doesn't set
      // `impersonation.routes`. The `/health` route is named on the same
      // reasoning; `/up` is deliberately not, being always-on.
      group.delete("/", StopImpersonationController).name("impersonation.stop");
    });
  }

  /**
   * Static, statically-imported migration sources rather than a directory
   * path, which is the bundle-safe form.
   */
  migrationSources(): RegisteredMigration[] {
    return [
      {
        name: "0001_create_impersonations_table",
        migration: createImpersonationsTable,
      },
    ];
  }

  commands() {
    return [ImpersonationGcCommand];
  }
}
