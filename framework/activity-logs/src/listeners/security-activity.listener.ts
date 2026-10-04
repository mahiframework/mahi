import type { Application } from "@mahiframework/core";
import type { Listener } from "@mahiframework/events";
import {
  CsrfTokenMismatch,
  CurrentDeviceLogout,
  EmailVerificationSent,
  EmailVerified,
  Failed,
  Login,
  Logout,
  OtherDeviceLogout,
  PasswordReset,
  PasswordResetLinkSent,
  TokenCreated,
  TokenRevoked,
  type AuthEvent,
} from "@mahiframework/auth";
import { ActivityLogger } from "../activity-logger.js";
import { ACTIVITY_LOG_TOKEN } from "../tokens.js";
import { stringifyKey } from "../actor.js";

/** What one auth event becomes: an action, a subject, and a payload. */
interface Record_ {
  action: string;
  /** The subject's key. Usually a user id; an email when none is known. */
  modelId: string;
  data: Record<string, unknown> | null;
}

/**
 * Turns `@mahiframework/auth` events into `security` rows.
 *
 * Registered ONCE against the abstract `AuthEvent` base rather than
 * fourteen times against each subclass. Listeners match with
 * `instanceof`, so the base catches every subclass including ones added
 * later — and for a security log, silently missing a newly added event is
 * the failure mode that matters most.
 *
 * ## Deliberately not recorded
 *
 * - **`Authenticated`.** It fires on every authenticated request, not
 *   once per login, so recording it would write a row per API call and
 *   drown the table. `Login` is the event that means "signed in".
 * - **`Attempted`.** It fires for both outcomes; `Failed` already covers
 *   the half worth recording, and logging both would double every
 *   failure.
 *
 * ## Two blind spots inherited from auth, and they are not bugs
 *
 * `Failed` cannot say whether a failed login targeted a real account —
 * `attempt()` deliberately does not know, which is what keeps the
 * enumeration oracle closed. And `PasswordResetLinkSent` does not fire at
 * all for an unknown address, because the response shape hides that
 * distinction and an event firing only for real accounts would record
 * exactly what the response conceals. So the activity log cannot answer
 * "was this a probe against a real account?" from events alone.
 */
export class SecurityActivityListener implements Listener<AuthEvent> {
  constructor(private readonly app: Application) {}

  async handle(event: AuthEvent): Promise<void> {
    const logger = this.app.make<ActivityLogger>(ACTIVITY_LOG_TOKEN);

    try {
      await this.record(logger, event);
    } catch (error) {
      if (logger.settings.throwOnFailure) {
        throw error;
      }

      // Auth dispatch does not catch either, so an uncaught throw here
      // would fail the login or password reset that dispatched it.
      this.app.logger.error("activity-logs: failed to write a security activity row", {
        event: event.eventName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async record(logger: ActivityLogger, event: AuthEvent): Promise<void> {
    const entry = this.describe(logger, event);

    if (entry === null) {
      return;
    }

    await logger.security(entry.action, entry.modelId, entry.data, this.actorFor(logger, event));
  }

  /**
   * The actor behind a security row.
   *
   * For most events the subject IS the actor: a user logging in did it to
   * themselves. The ambient auth state is preferred where it exists,
   * because an admin revoking someone else's tokens should be recorded as
   * the admin.
   */
  private actorFor(logger: ActivityLogger, event: AuthEvent): string | null {
    const ambient = logger.actor();

    if (ambient !== null) {
      return ambient;
    }

    const candidate = event as { userId?: unknown };

    return typeof candidate.userId === "string" ? candidate.userId : null;
  }

  private describe(logger: ActivityLogger, event: AuthEvent): Record_ | null {
    const userKey = logger.settings.security.userKey;

    if (event instanceof Login) {
      return {
        action: "login",
        modelId: event.userId,
        data: { guard: event.guard, remember: event.remember },
      };
    }

    if (event instanceof Logout) {
      // `userId` is nullable: `logout()` destroys a session without
      // loading a user, so a logout on a route that never ran
      // `authenticate()` has nobody to attribute it to.
      return event.userId === null
        ? null
        : { action: "logout", modelId: event.userId, data: { guard: event.guard } };
    }

    if (event instanceof Failed) {
      // No user id exists, and cannot: see the class docstring. The
      // identifying credential is the only subject available, so it goes
      // in `model_id` AND in `data` — the former to keep the
      // `(model_type, model_id)` index usable, the latter because a key
      // column holding an email is a lie about the column's meaning and
      // the honest copy should exist somewhere.
      const email = this.identifier(event.credentials);

      return email === null
        ? null
        : { action: "password_incorrect", modelId: email, data: { email, guard: event.guard } };
    }

    if (event instanceof PasswordReset) {
      return {
        action: "password_changed",
        modelId: stringifyKey(event.user, userKey) ?? event.email,
        data: { email: event.email },
      };
    }

    if (event instanceof PasswordResetLinkSent) {
      return {
        action: "password_change_requested",
        modelId: stringifyKey(event.user, userKey) ?? event.email,
        data: { email: event.email },
      };
    }

    if (event instanceof EmailVerified) {
      return {
        action: "email_verified",
        modelId: event.userId,
        data: { email: event.email },
      };
    }

    if (event instanceof EmailVerificationSent) {
      return {
        action: "email_verification_sent",
        modelId: event.userId,
        data: { email: event.email },
      };
    }

    if (event instanceof TokenCreated) {
      return {
        action: "token_created",
        modelId: event.userId,
        data: { token_id: event.tokenId, name: event.name },
      };
    }

    if (event instanceof TokenRevoked) {
      // A single-token revocation carries no user: `revokeToken(id)` does
      // not read the row it deletes. Nothing to attribute, so nothing is
      // written — the alternative would be a row whose subject is a token
      // id masquerading as a user key.
      return event.userId === null
        ? null
        : {
            action: "token_revoked",
            modelId: event.userId,
            data: { all: event.all, reason: event.reason },
          };
    }

    if (event instanceof CurrentDeviceLogout) {
      return {
        action: "sessions_revoked",
        modelId: event.userId,
        data: { scope: "all", reason: event.reason },
      };
    }

    if (event instanceof OtherDeviceLogout) {
      return {
        action: "sessions_revoked",
        modelId: event.userId,
        data: { scope: "others" },
      };
    }

    if (event instanceof CsrfTokenMismatch) {
      // No subject at all. Recorded against the ambient user when there
      // is one, and dropped otherwise rather than inventing a subject:
      // an anonymous CSRF rejection belongs in the access log.
      const actor = logger.actor();

      return actor === null
        ? null
        : {
            action: "csrf_rejected",
            modelId: actor,
            data: { method: event.method, path: event.path },
          };
    }

    // `Authenticated` and `Attempted` fall through deliberately; see the
    // class docstring.
    return null;
  }

  /**
   * The identifying credential out of a stripped credentials bag.
   *
   * Auth removes the secret before dispatch, so whatever remains is the
   * identifier — usually `email`, but an app keyed on `username` is
   * legitimate, hence the fallback to the first value rather than a
   * hardcoded key.
   */
  private identifier(credentials: Record<string, string>): string | null {
    const email = credentials["email"] ?? credentials["username"];

    if (typeof email === "string" && email.length > 0) {
      return email;
    }

    const first = Object.values(credentials).find((value) => value.length > 0);

    return first ?? null;
  }
}
