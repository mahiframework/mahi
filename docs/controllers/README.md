# Controllers

Mahi controllers are **single-action**. One class, one route, one `handle()`
method. There are no `index`/`store`/`show`/`update`/`destroy` resource
controllers and no route-to-method string references.

```ts
import { Controller, HttpResponse, type Request } from "@mahiframework/http";
import { Post } from "../../models/post.model.js";
import { PostResource } from "../resources/post.resource.js";

export class GetPostController extends Controller {
  async handle(request: Request) {
    const post = await request.model(Post);
    return HttpResponse.json(await new PostResource(post).toJson());
  }
}
```

```ts
router.get("/posts/{post}", GetPostController).name("posts.show");
```

Generate one with `./artisan make:controller`.

## The base class

```ts
export abstract class Controller<R extends Request = Request> {
  request?: RequestClass<R>;
  abstract handle(request: R): ResponseInput | Promise<ResponseInput>;
}
```

That's the entire class. It ships with **no behaviour**, no helper
methods, no injected services, no constructor. It exists so applications
can build their own inheritance chains and put whatever they want on their
own base:

```ts
abstract class ApiController extends Controller {
  protected ok(data: unknown) {
    return HttpResponse.json({ data });
  }
}

export class ShowController extends ApiController {
  async handle() {
    return this.ok({ id: 1 });
  }
}
```

`handle()` may return anything assignable to `ResponseInput`: a framework
`HttpResponse` (or `JsonResponse`/`FileResponse`/`RedirectResponse`) or a
platform `Response`. See [Responses](../responses/).

`isControllerClass(value)` is how the router tells a controller class from
a plain handler function. It checks `value.prototype instanceof Controller`.
That's why extending `Controller` is required rather than merely having a
`handle` method.

## Declaring a form request

Set the `request` property to a `Request` subclass and the framework
upgrades the incoming request to it, authorizes, and validates before
`handle()` runs:

```ts
export class CreatePostController extends Controller<CreatePostRequest> {
  request = CreatePostRequest;

  async handle(request: CreatePostRequest) {
    const { body, images } = request.validated();
    // body: string, images: File[] | undefined
    // …
  }
}
```

The generic parameter is what types `handle()`'s argument and, through it,
`request.validated()`. Writing `Controller<CreatePostRequest>` without
`request = CreatePostRequest` compiles but does nothing at runtime. The
property is the runtime signal; the generic is the compile-time one. Keep
them in sync.

## The per-request pipeline

`controllerToHandler(ControllerClass)` normalizes a controller class into
the `RouteHandler` the router mounts. Per request, in exactly this order:

```ts
return async (request: Request) => {
  const instance = new ControllerClass();
  const typed = instance.request ? instance.request.fromExisting(request) : request;

  await typed.prepareInput();

  const allowed = await typed.authorize();
  if (allowed === false) throw HttpError.forbidden();

  await typed.validateOrFail();

  return instance.handle(typed);
};
```

### 1. Construct a fresh instance

`new ControllerClass()`, no arguments, every request.

**There is no constructor dependency injection.** The `ControllerClass`
type is `new () => Controller<R>`, so the container never has to guess what
a constructor parameter means. Controllers reach services through the
existing facades and helpers (`Auth`, `authorize()`, `Events`, `Bus`,
`URL`), or `app().make(TOKEN)` for anything else. This keeps the base
class dependency-free and resolution readable. See the "explicit
resolution, no decorators" principle in the [overview](../).

### 2. Upgrade the request

If `instance.request` is set, `RequestClass.fromExisting(request)` produces
the subclass instance. It copies every parsed bag **by reference**: the
input bag, file bag, header bag, the shared bag, and the model cache. It
also takes over the Hono context's cached-request slot, so anything
downstream that calls `requestFromContext(c)` gets the upgraded instance.

The practical consequence: `request.model(Post)` inside the form request's
`authorize()` and inside `handle()` share one cache entry and hit the
database once.

If `instance.request` is unset, the base `Request` is passed straight
through.

### 3. Authorize

```ts
const allowed = await typed.authorize();
if (allowed === false) throw HttpError.forbidden();
```

`Request.authorize()` **defaults to returning `true`**, so a request that
doesn't override it falls straight through.

**Only an explicit `false` throws.** `undefined`, `void`, and `true` all
pass. That's deliberate: `@mahiframework/authorization`'s `authorize(ability, …)`
returns `Promise<void>` and throws on denial, so delegating to it works
without the framework second-guessing the return value:

```ts
override authorize() {
  return authorize("create", Post);   // Promise<void> — throws, never returns false
}
```

Throwing `HttpError.forbidden()` yourself works identically.

### 4. Validate

```ts
await typed.prepareInput();      // prepareForValidation()
const allowed = await typed.authorize();
if (allowed === false) throw HttpError.forbidden();
await typed.validateOrFail();
```

Validation is **skipped entirely** when `rules()` is empty. No `Validator`
is constructed. A failure throws `ValidationException`, which the central
error handler renders as `422` with a per-field `errors` bag.

Once the rules pass, `validate()` runs
[`passedValidation()`](../requests/#passedvalidation), the hook for a
second pass whose schema depends on an already-validated field. A
`ValidationException` from it is the same `422`.

### Why prepare runs before authorize

`prepareForValidation()` is where a request normalizes its own input,
lowercasing an email, merging a route param or the current user. Running
it after `authorize()` (as the pipeline previously did, because it was
buried inside `validate()`) means authorization inspects the *raw* bag,
so a request that authorizes against something it merged is denied when
it should be allowed. Laravel prepares first for the same reason.

### Why authorize runs before validate

This is Laravel's order, and it's the right one. A request that isn't
allowed to perform the action gets a `403` regardless of whether its payload
was well-formed. Validating first would tell an unauthorized caller which
fields your endpoint accepts and which of their values were malformed,
free schema reconnaissance for someone who was never going to be permitted
through.

The framework's own test asserts this: an invalid *and* unauthorized
request returns `403`, not `422`.

### Status codes

| Stage | Failure | Status |
|---|---|---|
| `authorize()` returns `false` | `HttpError.forbidden()` | `403` |
| `authorize()` throws `HttpError` | that error's status | its own |
| `validateOrFail()` | `ValidationException` | `422` |
| `passedValidation()` throws `ValidationException` | merged into the bag, then `422` | `422` |
| `handle()` throws `HttpError` | that error's status | its own |
| `handle()` throws anything else | logged, generic | `500` |

See [error handling](../responses/#error-handling) for exact body shapes.

## Why a fresh instance per request

The container never caches controller instances. Every request constructs
its own.

Node keeps a single process alive across every concurrent request. A
long-lived controller instance would share mutable state between them, a
`private currentUser` assigned in one request is visible to another that
interleaves at the next `await`. That's not a theoretical race; it's the
default outcome, and the bug it produces (one user's data in another user's
response) is the worst class of bug an application framework can make easy.

Construction is cheap: an empty object with a prototype. The alternative,
singleton controllers with a discipline of "never store request state on
`this`", trades a free allocation for a rule that only holds until someone
forgets it.

If a controller genuinely needs expensive per-instance setup, that's a
signal the work belongs in a service bound as a singleton in a
[provider](../providers/) and resolved inside `handle()`.

## Both authorization styles

Authorization on the form request, when the check needs no loaded model:

```ts
export class CreatePostRequest extends Request {
  override authorize() {
    return authorize("create", Post);
  }
  rules() { /* … */ }
}
```

Authorization in the controller, when it does:

```ts
export class DeletePostController extends Controller {
  async handle(request: Request) {
    const existing = await request.model(Post);
    await authorize("delete", Post, existing);

    await Post.delete(existing.id);
    return HttpResponse.json({ deleted: true });
  }
}
```

The second form runs after the model fetch, which the request-level hook
can't easily do without duplicating the query, though the model cache
means it wouldn't actually cost a second round trip if you did.

## A worked example

```ts
// src/http/requests/register.request.ts
export class RegisterRequest extends Request {
  rules() {
    return {
      name: rule().string().required().min(1),
      email: rule().string().email().required().unique(User, "email"),
      password: rule().string().required().min(8),
    } as const;
  }
}

// src/http/controllers/register.controller.ts
export class RegisterController extends Controller<RegisterRequest> {
  request = RegisterRequest;

  async handle(request: RegisterRequest) {
    const payload = request.validated();
    // { name: string; email: string; password: string }

    const user = (await User.create({
      name: payload.name,
      email: payload.email,
      password: await Hash.make(payload.password),
      deleted_at: null,
    })) as UserTable;

    const guard = Auth.guard("token") as TokenGuard<UserTable>;
    const { token } = await guard.createToken(user.id, "registration");

    return HttpResponse.json({ user: new UserResource(user).toJson(), token }, 201);
  }
}

// src/routes/auth.routes.ts
router.group("/auth", (auth) => {
  auth.post("/register", RegisterController)
    .middleware(throttle("register"))
    .name("auth.register");
});
```

`request.validated()` is fully typed from `RegisterRequest.rules()`, no
casts, no `as`, no separate DTO interface. See
[typed output](../validation/#typed-output) for how.

## Plain function handlers

Controllers aren't mandatory. A route target may be any
`(request: Request) => ResponseInput | Promise<ResponseInput>`:

```ts
router.get("/health", () => HttpResponse.json({ ok: true }));
router.get("/storage/*", servePublicDisk("public"));
```

Function handlers get none of the pipeline, no form-request upgrade, no
`authorize()`, no validation. They're right for trivial endpoints and for
handlers a package hands you pre-built.

## Related

- [Requests](../requests/): form requests, `authorize()`, `validated()`
- [Validation](../validation/): rules and typed output
- [Responses](../responses/): return values and error handling
- [Routing](../routing/): mounting controllers on routes
- [Authorization](../authorization/): gates, policies, `authorize()`
- [Service providers](../providers/): where to bind services controllers resolve
