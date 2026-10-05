import { app } from "@mahiframework/core";
import { HttpError, type HttpPipeFn } from "@mahiframework/http";
import type { GuardOption, PermissionRegistrar } from "../permission-registrar.js";
import { PERMISSIONS_TOKEN } from "../tokens.js";
import { currentSubject } from "./current-subject.js";

export interface RoleOrPermissionOptions extends GuardOption {
  roles?: string[];
  permissions?: string[];
}

/**
 * Require the subject to hold one of `roles` OR one of `permissions`.
 *
 *   group.middleware(
 *     authenticate(),
 *     roleOrPermission({ roles: ["admin"], permissions: ["posts.edit"] }),
 *   );
 *
 * A separate pipe rather than stacking `role()` and `permission()`,
 * because stacking them is an AND: both would have to pass. This is the
 * OR, and spatie's `role_or_permission:` middleware exists for the same
 * reason.
 *
 * Takes a named object rather than two positional arrays: `roleOrPermission(
 * ["admin"], ["posts.edit"])` is unreadable at the call site and silently
 * wrong if the arguments are swapped, which is undetectable because both
 * are `string[]`.
 *
 * Roles are checked first, so an admin costs no permission lookup. Both
 * reads come from the same per-request memo regardless.
 */
export function roleOrPermission(options: RoleOrPermissionOptions): HttpPipeFn {
  const roles = options.roles ?? [];
  const permissions = options.permissions ?? [];

  return async (request, next) => {
    const subject = currentSubject();

    if (subject === null) {
      throw HttpError.forbidden();
    }

    const registrar = app().make<PermissionRegistrar>(PERMISSIONS_TOKEN);

    if (roles.length > 0 && (await registrar.hasAnyRole(subject, roles, options))) {
      return next(request);
    }

    if (
      permissions.length > 0 &&
      (await registrar.hasAnyPermission(subject, permissions, options))
    ) {
      return next(request);
    }

    throw HttpError.forbidden();
  };
}
