import { HttpError } from "./http-error.js";
import { Request } from "./request.js";
import type { ResponseInput } from "./response.js";

export type RequestClass<R extends Request = Request> = (new (...args: any[]) => R) & {
  fromExisting(source: Request): R;
};

export type RouteHandler = (request: Request) => ResponseInput | Promise<ResponseInput>;

/**
 * Lightweight base for class-based controllers. Ships with **no
 * behaviour**. It exists purely so applications can build inheritance
 * chains (e.g. `CreatePostController extends ApiController extends
 * Controller`) and share whatever a project needs on its own base. All the
 * framework requires of a subclass is a `handle()` method.
 *
 *   export class GetPostController extends Controller {
 *     async handle(request: Request) {
 *       const post = await request.model(Post);
 *       return HttpResponse.json(await new PostResource(post).toJson());
 *     }
 *   }
 *
 * A controller may **declare a Form Request** by assigning `request`. When
 * set, the framework upgrades the incoming request to that subclass and,
 * before `handle()` runs, calls its `authorize()` (opt-in, Laravel order:
 * authorize → 403, then validate → 422). `handle()` then receives the
 * fully-validated, typed request:
 *
 *   export class CreatePostController extends Controller<CreatePostRequest> {
 *     request = CreatePostRequest;
 *     async handle(request: CreatePostRequest) {
 *       const { body } = request.validated();
 *       ...
 *     }
 *   }
 *
 * Controllers reach services through the existing facades (`Auth`,
 * `authorize`, `Events`, …). There is no constructor DI, keeping the base
 * dependency-free. A fresh instance is constructed per request.
 */
export abstract class Controller<R extends Request = Request> {
  /**
   * Optional Form Request binding. When set, the request is upgraded to
   * this subclass, authorized, and validated before `handle()` runs.
   */
  request?: RequestClass<R>;

  abstract handle(request: R): ResponseInput | Promise<ResponseInput>;
}

export type ControllerClass<R extends Request = Request> = new () => Controller<R>;

/** True for a class (not instance) that extends `Controller`. */
export function isControllerClass(value: unknown): value is ControllerClass<any> {
  return typeof value === "function" && value.prototype instanceof Controller;
}

/**
 * Normalise a controller class into a `RouteHandler` the router can mount.
 * Per request it constructs a fresh instance, upgrades the request to the
 * declared Form Request (if any), then runs the Laravel-ordered pipeline:
 * `prepareForValidation()` → `authorize()` (→ 403) → validation →
 * `passedValidation()` (either → 422) → `handle()`.
 *
 * `prepareForValidation()` runs FIRST, matching Laravel's
 * `ValidatesWhenResolvedTrait`. Running it after `authorize()` would break
 * the ordinary case of a request that merges a route param or the current
 * user into the input and then authorizes against it. `authorize()` would
 * see the un-prepared bag and deny a request it should allow.
 */
export function controllerToHandler(ControllerClass: ControllerClass<any>): RouteHandler {
  return async (request: Request) => {
    const instance = new ControllerClass();
    const typed = instance.request ? instance.request.fromExisting(request) : request;

    await typed.prepareInput();

    // Then authorize: a denied request 403s before any validation runs,
    // so an unauthorized caller learns nothing about which fields are
    // invalid. `authorize()` defaults to allow, so requests that don't
    // override it fall straight through.
    const allowed = await typed.authorize();

    if (allowed === false) {
      throw HttpError.forbidden();
    }

    await typed.validateOrFail();

    return instance.handle(typed);
  };
}
