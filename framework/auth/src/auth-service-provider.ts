import { ServiceProvider, CACHE_TOKEN } from "@mahiframework/core";
import type { RegisteredMigration } from "@mahiframework/database";
import createPersonalAccessTokensTable from "./migrations/0001_create_personal_access_tokens_table.js";
import createSessionsTable from "./migrations/0002_create_sessions_table.js";
import createPasswordResetTokensTable from "./migrations/0003_create_password_reset_tokens_table.js";
import { HASHER_TOKEN, SIGNER_TOKEN, type Hasher, type Signer } from "@mahiframework/encryption";
import type { HttpPipe } from "@mahiframework/http";
import { AuthManager, type AuthConfig } from "./auth-manager.js";
import { actingAs, runWithAuth } from "./auth-context.js";
import {
  DatabaseUserProvider,
  type DatabaseUserProviderConfig,
} from "./providers/database-user-provider.js";
import { TokenGuard, type TokenGuardConfig } from "./guards/token-guard.js";
import { SessionGuard, type SessionGuardConfig } from "./guards/session-guard.js";
import { DatabaseSessionStore } from "./session/database-session-store.js";
import { CacheSessionStore, type SessionCacheStore } from "./session/cache-session-store.js";
import { ArraySessionStore } from "./session/array-session-store.js";
import type { SessionStore } from "./session/session-store.js";
import { AuthGcCommand } from "./commands/auth-gc.js";
import { AUTH_TOKEN } from "./tokens.js";

export { AUTH_TOKEN };

/**
 * Registers the `AuthManager` singleton with the two built-in guards
 * ("token", "session") and the built-in "database" user provider
 * pre-registered via `extend()`/`extendUserProvider()`, the same
 * mechanisms a plugin would use to add a JWT or LDAP driver later.
 *
 * Contributes the `personal_access_tokens`/`sessions` migrations and the
 * `auth:gc` command.
 *
 * ORDERING: list this provider after `DatabaseServiceProvider` (user
 * lookups and both framework tables), `EncryptionServiceProvider`
 * (`HASHER_TOKEN` for passwords, `SIGNER_TOKEN` for session cookies) and
 * `CacheServiceProvider` (only if using the "cache" session store), and
 * BEFORE `HttpServiceProvider` so `AUTH_TOKEN` is bound and the global
 * auth-scope pipe below is collected before routes and middleware are.
 */
export class AuthServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(AUTH_TOKEN, (app) => {
      const config = app.config.require<AuthConfig>("auth");
      const hasher = app.make<Hasher>(HASHER_TOKEN);
      const manager = new AuthManager(app, config, hasher);

      manager.extendUserProvider(
        "database",
        (_app, providerConfig) =>
          new DatabaseUserProvider(providerConfig as DatabaseUserProviderConfig, hasher),
      );

      // Registered by DRIVER name, and configured through a bare
      // `guardConfig()` so each factory reads the config of the guard
      // being resolved rather than a hardcoded key. That is what lets
      // Laravel's `{ web: { driver: "session" }, admin: { driver:
      // "session", cookie: "admin_session" } }` resolve two independently
      // configured session guards. See `AuthManager.guard()`.
      manager.extend("token", () => {
        const guardConfig = manager.guardConfig() as TokenGuardConfig;

        return new TokenGuard(manager.userProvider(guardConfig.provider), {
          name: manager.resolvingGuardName(),
          ...guardConfig,
        });
      });

      manager.extend("session", () => {
        const guardConfig = manager.guardConfig() as SessionGuardConfig;
        const signer = app.make<Signer>(SIGNER_TOKEN);

        return new SessionGuard(
          manager.userProvider(guardConfig.provider),
          this.sessionStore(guardConfig.store ?? "database"),
          signer,
          { name: manager.resolvingGuardName(), ...guardConfig },
        );
      });

      return manager;
    });
  }

  /**
   * Open an EMPTY auth scope for every request.
   *
   * This is why `Auth.userOrNull()` works on public routes while
   * `MissingAuthContextError` stays reserved for genuinely non-HTTP
   * callers (queue jobs, CLI). `authenticate()` then mutates this state
   * in place rather than nesting a scope, so one request has exactly one
   * identity throughout.
   *
   * The scope is seeded from any acting-as override (Laravel's
   * `Auth::actingAs()`), so a test that sets one authenticates every
   * subsequent request as that user without a fake guard leaking into the
   * shared `AuthManager`.
   */
  middleware(): HttpPipe[] {
    return [
      (request, next) => {
        const override = actingAs();
        const state = override
          ? { user: override.user, guard: override.guard }
          : { user: null, guard: null };

        return runWithAuth(state, () => next(request));
      },
    ];
  }

  /**
   * Static rather than a `migrations()` directory path. See
   * `QueueServiceProvider.migrationSources()`. Names are byte-identical
   * to the filenames they replace, so apps already migrated under the
   * directory form do not re-run them.
   */
  migrationSources(): RegisteredMigration[] {
    return [
      {
        name: "0001_create_personal_access_tokens_table",
        migration: createPersonalAccessTokensTable,
      },
      { name: "0002_create_sessions_table", migration: createSessionsTable },
      {
        name: "0003_create_password_reset_tokens_table",
        migration: createPasswordResetTokensTable,
      },
    ];
  }

  commands() {
    return [AuthGcCommand];
  }

  private sessionStore(name: string): SessionStore {
    if (name === "database") {
      return new DatabaseSessionStore();
    }

    if (name === "array") {
      return new ArraySessionStore();
    }

    if (name === "cache") {
      // Resolved by string token rather than importing @mahiframework/cache,
      // so auth doesn't take a package dependency for one optional store,
      // the same soft-dependency shape schedule uses for QUEUE_TOKEN.
      // `CACHE_TOKEN` comes from @mahiframework/core's well-known-tokens,
      // the shared source of truth, not a private string literal here.
      const manager = this.app.make<{ store(): SessionCacheStore }>(CACHE_TOKEN);

      return new CacheSessionStore(manager.store());
    }

    throw new Error(
      `Unknown session store "${name}". Built-in stores are "database", "cache", and "array".`,
    );
  }
}
