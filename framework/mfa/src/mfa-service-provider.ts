import { ServiceProvider } from "@mahiframework/core";
import type { RegisteredMigration } from "@mahiframework/database";
import {
  ENCRYPTER_TOKEN,
  HASHER_TOKEN,
  SIGNER_TOKEN,
  type Encrypter,
  type Hasher,
  type Signer,
} from "@mahiframework/encryption";
import type { HttpPipe } from "@mahiframework/http";
import { MfaManager } from "./mfa-manager.js";
import type { MfaConfig } from "./mfa-config.js";
import { MFA_TOKEN } from "./tokens.js";
import { runWithMfa } from "./mfa-context.js";
import { TotpDriver } from "./drivers/totp-driver.js";
import { EmailDriver } from "./drivers/email-driver.js";
import { RecoveryDriver } from "./drivers/recovery-driver.js";
import { MfaGcCommand } from "./commands/mfa-gc.js";
import createMfaMethodsTable from "./migrations/0001_create_mfa_methods_table.js";
import createMfaIntentsTable from "./migrations/0002_create_mfa_intents_table.js";
import createMfaChallengesTable from "./migrations/0003_create_mfa_challenges_table.js";
import createMfaRecoveryCodesTable from "./migrations/0004_create_mfa_recovery_codes_table.js";

/**
 * Registers the MFA manager, its three built-in drivers, the four
 * tables, and the per-request scope the inline helpers read.
 *
 * ORDERING. List this provider:
 *
 * - AFTER `AuthServiceProvider`. `MfaManager` resolves `AUTH_TOKEN` to
 *   reach the user provider and to capability-probe the active guard
 *   for a session binding.
 * - AFTER `EncryptionServiceProvider`, for `ENCRYPTER_TOKEN` (the TOTP
 *   secret), `HASHER_TOKEN` (emailed codes) and `SIGNER_TOKEN` (the
 *   optional magic link).
 * - AFTER `DatabaseServiceProvider`, for its own four tables.
 * - BEFORE `HttpServiceProvider`, so the middleware pipe below is
 *   collected before routes and middleware are.
 *
 * The last one is the only non-obvious constraint, and getting it wrong
 * fails loudly rather than silently: every `requireMfa()` throws
 * `MissingMfaContextError` naming this exact cause.
 *
 * All three drivers are registered unconditionally; `config.drivers` is
 * what exposes one to users. Registration is cheap (no I/O, no key
 * material read at construction), and separating the two means enabling
 * a factor is a one-line config change rather than a provider edit.
 */
export class MfaServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(MFA_TOKEN, (app) => {
      const config = app.config.require<MfaConfig>("mfa");
      const manager = new MfaManager(app, config);

      manager.extend(
        "totp",
        () => new TotpDriver(app.make<Encrypter>(ENCRYPTER_TOKEN), config.totp ?? {}),
      );

      manager.extend(
        "email",
        () =>
          new EmailDriver(
            app.make<Hasher>(HASHER_TOKEN),
            app.make<Signer>(SIGNER_TOKEN),
            config.email ?? {},
          ),
      );

      manager.extend("recovery", () => new RecoveryDriver(config.recovery ?? {}));

      return manager;
    });
  }

  /**
   * Open an MFA scope for every request, carrying the request and the
   * binding derived from the active guard.
   *
   * Computed once here rather than per `requireMfa()` call: it is a
   * cookie read plus an HMAC verify, and one handler may guard several
   * actions.
   *
   * The binding is resolved LAZILY inside the pipe rather than eagerly
   * at provider-collection time, because resolving the guard requires
   * the container to be fully booted. A failure to derive one degrades
   * to `null` (user-only matching) rather than failing the request: a
   * guard that exposes no per-request identifier is a supported
   * configuration, not an error.
   */
  middleware(): HttpPipe[] {
    return [
      (request, next) => {
        let binding: string | null = null;

        try {
          binding = this.app.make<MfaManager>(MFA_TOKEN).bindingFor(request);
        } catch (error) {
          this.app.logger.error("mfa: could not derive a session binding.", { error });
        }

        return runWithMfa({ binding, request }, () => next(request));
      },
    ];
  }

  /**
   * Static rather than a directory path, matching
   * `AuthServiceProvider`. Names are stable, so an app that has already
   * migrated does not re-run them.
   */
  migrationSources(): RegisteredMigration[] {
    return [
      { name: "0001_create_mfa_methods_table", migration: createMfaMethodsTable },
      { name: "0002_create_mfa_intents_table", migration: createMfaIntentsTable },
      { name: "0003_create_mfa_challenges_table", migration: createMfaChallengesTable },
      { name: "0004_create_mfa_recovery_codes_table", migration: createMfaRecoveryCodesTable },
    ];
  }

  commands() {
    return [MfaGcCommand];
  }
}
