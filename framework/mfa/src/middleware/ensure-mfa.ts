import type { HttpPipe } from "@mahiframework/http";
import { requireMfa } from "../require-mfa.js";
import type { WhenUnenrolled } from "../mfa-config.js";

export interface EnsureMfaOptions {
  whenUnenrolled?: WhenUnenrolled;
}

/**
 * Require a live verified MFA intent for the whole route, else 403.
 *
 * Place it AFTER `authenticate()`, since it reads the user that
 * middleware resolves into the ambient auth scope:
 *
 *   router.post("/account/password", UpdatePasswordController)
 *     .middleware(authenticate(), ensureMfa("change_password"));
 *
 * PREFER THIS over inline `await requireMfa()` when the check applies
 * to the whole endpoint. Not only for the reason `can()` is preferred
 * over `authorize()` — having the guard visible in the route table is
 * worth real money when auditing what protects an endpoint — but
 * because a pipe cannot be mis-awaited. `requireMfa()` returns a
 * promise, and a forgotten `await` on it continues past the check
 * silently. There is no way to make that mistake here.
 *
 * Named `ensureMfa` rather than `requireMfa` to match
 * `ensureEmailVerified()`, and to leave that name to the free function.
 *
 * A guest 401s rather than 403ing, matching the "authenticating
 * differently could fix a 401, different credentials won't fix a 403"
 * split; `requireMfa()` owns that distinction.
 */
export function ensureMfa(purpose?: string | null, options: EnsureMfaOptions = {}): HttpPipe {
  return async (request, next) => {
    await requireMfa(purpose, {
      ...(options.whenUnenrolled === undefined ? {} : { whenUnenrolled: options.whenUnenrolled }),
    });

    return next(request);
  };
}
