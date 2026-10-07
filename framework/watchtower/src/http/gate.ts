import { AUTH_TOKEN, app } from "@mahiframework/core";
import { HttpError, type HttpPipeFn } from "@mahiframework/http";
import { WATCHTOWER_TOKEN } from "../tokens.js";
import type { WatchtowerManager } from "../watchtower-manager.js";

/** The shape read off the `AuthManager` to find the current user. */
interface CurrentUserSource {
  userOrNull(): unknown | null;
}

/**
 * Refuse the request unless the registered gate allows the current user.
 *
 * Registered by this package's `routes()` hook as the LAST pipe inside
 * the dashboard group, after whatever authentication the app configured.
 * It is not optional and cannot be disabled from config: a queue
 * dashboard exposes job payloads and stack traces, so the failure mode of
 * a forgotten authorization check is a data leak.
 *
 * **Deny is the default.** With no `Watchtower.gate()` registered this
 * refuses everyone, so installing the package and setting
 * `watchtower.dashboard` grants nothing. An app that forgets the gate
 * gets a locked door rather than an open one.
 *
 * ## 403, not 401
 *
 * A guest is forbidden, not unauthorized. 401 is not an authorization
 * decision, and a route that wants "log in" says so by carrying an
 * `authenticate()` pipe ahead of this one — the same stance the
 * permissions middleware and the `Gate` take.
 *
 * ## Why the user is read from `AUTH_TOKEN` directly
 *
 * Not `request.user()`, which wraps its lookup in a `try`/`catch` and
 * returns `undefined` on any failure. That is the wrong shape here: it
 * would turn "this route has no auth scope at all" into "this is a
 * guest", which is an authorization decision made by accident. A missing
 * auth context must propagate and 500 rather than quietly denying,
 * because the two have very different fixes.
 */
export function watchtowerGate(): HttpPipeFn {
  return async (request, next) => {
    const container = app();
    const watchtower = container.make<WatchtowerManager>(WATCHTOWER_TOKEN);

    const user = container.has(AUTH_TOKEN)
      ? container.make<CurrentUserSource>(AUTH_TOKEN).userOrNull()
      : null;

    if (!(await watchtower.allows(user))) {
      // Deliberately the same response whether the gate said no, no gate
      // is registered, or nobody is authenticated. The status must not
      // reveal which — "there is no gate here" is useful information to
      // an attacker and none to a legitimate user, who sees the same 403
      // either way.
      //
      // The distinction IS logged, because it is the only thing that
      // tells an operator why their own dashboard refuses them.
      if (!watchtower.hasGate()) {
        container.logger.warning(
          "watchtower: the dashboard refused a request because no gate is registered. " +
            "Call `Watchtower.gate(...)` from a provider's boot().",
        );
      }

      throw HttpError.forbidden();
    }

    return next(request);
  };
}
