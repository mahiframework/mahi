import { app } from "@mahiframework/core";
import { HttpError, type HttpPipeFn } from "@mahiframework/http";
import type { GuardOption, PermissionRegistrar } from "../permission-registrar.js";
import { PERMISSIONS_TOKEN } from "../tokens.js";
import { currentSubject } from "./current-subject.js";

/**
 * Require the authenticated subject to hold one of `roles`.
 *
 *   admin.middleware(authenticate(), role("admin"));
 *   admin.middleware(authenticate(), role(["admin", "editor"]));
 *
 * ANY-of, not all-of, matching spatie's `role:` middleware. For all-of,
 * use `Permissions.hasAllRoles()` in the controller, where the intent is
 * legible; a route string cannot express the difference and silently
 * choosing one is how an app ends up with the wrong one.
 *
 * Place AFTER `authenticate()`. A guest is denied with 403, not 401,
 * because 401 is not an authorization decision — the same stance the
 * gate takes. `Router.middleware()` throws when called after a route is
 * registered, so getting the order wrong inside a group is a boot
 * failure rather than a hole.
 */
export function role(roles: string | string[], options: GuardOption = {}): HttpPipeFn {
  const names = Array.isArray(roles) ? roles : [roles];

  return async (request, next) => {
    const subject = currentSubject();

    if (subject === null) {
      throw HttpError.forbidden();
    }

    const registrar = app().make<PermissionRegistrar>(PERMISSIONS_TOKEN);

    if (!(await registrar.hasAnyRole(subject, names, options))) {
      throw HttpError.forbidden();
    }

    return next(request);
  };
}
