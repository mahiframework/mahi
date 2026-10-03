import { app } from "@mahiframework/core";
import { AUTH_TOKEN, type AuthManager } from "@mahiframework/auth";
import { Controller, HttpError, HttpResponse, type Request } from "@mahiframework/http";
import type { ImpersonationConfig } from "../impersonation-config.js";
import type { ImpersonationManager } from "../impersonation-manager.js";
import { ImpersonatorMissingError } from "../errors.js";
import { IMPERSONATION_TOKEN } from "../tokens.js";

/**
 * `DELETE {prefix}`, end the current impersonation.
 *
 * `DELETE` rather than `POST .../stop`: the impersonation is a resource,
 * and stopping deletes it.
 *
 * Takes no id and runs no authorization. The caller is the impersonated
 * user at this point, and requiring permission to leave is how an admin
 * ends up trapped in someone else's account after their own access is
 * revoked mid-impersonation.
 */
export class StopImpersonationController extends Controller {
  async handle(request: Request) {
    const container = app();
    const impersonation = container.make<ImpersonationManager>(IMPERSONATION_TOKEN);

    try {
      const record = await impersonation.stop(request);

      // 409 rather than 404: the request is well-formed and the route
      // exists, the session simply isn't impersonating anything. A 404
      // would read as "no such endpoint". Constructed directly because
      // `HttpError` ships no `conflict()` factory, and adding one to the
      // http package for a single caller here would be scope creep.
      if (record === null) {
        throw new HttpError(409, "This session is not impersonating anyone.");
      }

      return HttpResponse.json({ stopped: true, returnedTo: record.impersonator_id });
    } catch (error) {
      if (error instanceof ImpersonatorMissingError) {
        // The impersonator's account is gone, so there is nobody to return
        // to. Leaving the session logged in as the impersonated user would
        // silently convert a deleted admin's impersonation into a
        // permanent, unaudited login to someone else's account. Log out
        // instead and make the client re-authenticate.
        const config = container.config.get<ImpersonationConfig>("impersonation") ?? {};
        await container.make<AuthManager>(AUTH_TOKEN).logout(request, config.routes?.guard);
      }

      throw error;
    }
  }
}
