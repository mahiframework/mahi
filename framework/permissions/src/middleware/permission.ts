import { app } from "@mahiframework/core";
import { HttpError, type HttpPipeFn } from "@mahiframework/http";
import type { GuardOption, PermissionRegistrar } from "../permission-registrar.js";
import { PERMISSIONS_TOKEN } from "../tokens.js";
import { currentSubject } from "./current-subject.js";

/**
 * Require the authenticated subject to hold one of `permissions`, by
 * either route (a role, or directly).
 *
 *   posts.patch("/{post}", update).middleware(authenticate(), permission("posts.edit"));
 *
 * ANY-of, as `role()` is. See that pipe for the guest/403 reasoning and
 * the ordering constraint.
 *
 * `can("posts.edit")` from `@mahiframework/authorization` does the same
 * thing, via the gate hook this package registers. Reach for this one
 * when the gate hook is disabled (`permissions.gate: false`), when the
 * check needs a non-default guard, or when the route should read as a
 * permission check rather than an ability check.
 */
export function permission(permissions: string | string[], options: GuardOption = {}): HttpPipeFn {
  const names = Array.isArray(permissions) ? permissions : [permissions];

  return async (request, next) => {
    const subject = currentSubject();

    if (subject === null) {
      throw HttpError.forbidden();
    }

    const registrar = app().make<PermissionRegistrar>(PERMISSIONS_TOKEN);

    if (!(await registrar.hasAnyPermission(subject, names, options))) {
      throw HttpError.forbidden();
    }

    return next(request);
  };
}
