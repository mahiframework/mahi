import { app } from "@mahiframework/core";
import { AUTH_TOKEN, type AuthManager } from "@mahiframework/auth";
import { Controller, HttpError, HttpResponse, type Request } from "@mahiframework/http";
import type { ImpersonationConfig } from "../impersonation-config.js";
import type { ImpersonationManager } from "../impersonation-manager.js";
import { IMPERSONATION_TOKEN } from "../tokens.js";

/**
 * `POST {prefix}/{user}`, begin impersonating the given user.
 *
 * Registered only when `impersonation.routes` is configured. An app that
 * wants its own response shape, audit logging or middleware omits that key
 * and calls `ImpersonationManager` from its own controller; everything
 * here is a thin wrapper over `start()`.
 *
 * The target is resolved through the guard's own user provider rather than
 * a model binding, so it honours whatever `config/auth.ts` already says a
 * user is, including global scopes (a soft-deleted user simply isn't
 * found).
 */
export class StartImpersonationController extends Controller {
  async handle(request: Request) {
    const container = app();
    const impersonation = container.make<ImpersonationManager>(IMPERSONATION_TOKEN);
    const auth = container.make<AuthManager>(AUTH_TOKEN);
    const config = container.config.get<ImpersonationConfig>("impersonation") ?? {};

    const parameter = config.routes?.parameter ?? "user";
    const id = request.route(parameter);

    if (id === undefined || id === "") {
      throw HttpError.badRequest(`No "${parameter}" was given to impersonate.`);
    }

    const providerName = auth.guardConfig(config.routes?.guard)["provider"] as string | undefined;
    const target = await auth.userProvider(providerName).retrieveById(id);

    // 404 rather than 403: "no such user" is not an authorization failure,
    // and `can()` already establishes this distinction for a resolver that
    // finds nothing.
    if (target === null) {
      throw HttpError.notFound();
    }

    const record = await impersonation.start(request, target as Record<string, unknown>);

    return HttpResponse.json({
      impersonating: record.impersonated_id,
      impersonator: record.impersonator_id,
      depth: record.depth,
    });
  }
}
