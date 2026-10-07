# Authorization

`@mahiframework/authorization` answers *"may this user do this to this thing"*.
[Authentication](../authentication/) answers the other half. *who* is
making the request.

```ts
import { Gate, authorize, can, Policy, requireAuth } from "@mahiframework/authorization";

await Gate.authorize("update", Post, post);        // throws 403 if denied
if (await Gate.allows("create", Post)) { /* ... */ }
```

The package deliberately takes **no compile-time dependency on
`@mahiframework/auth`**. It resolves the current user through a runtime
`AUTH_TOKEN` lookup, the same soft-dependency shape `@mahiframework/schedule` uses
for queues, so authorization also works against a user from anywhere
else: an external identity provider, a queue job, a test. If auth isn't
installed at all, every check sees a guest rather than crashing.

There is **no `config/authorization.ts`**. Unlike every other package in
this framework, a gate has nothing configurable, no drivers, no
connections, no defaults. Its absence is intentional.

## Setup

`AuthorizationServiceProvider` binds a `GateRegistry` singleton at
`GATE_TOKEN` and, during its `boot()`, walks every registered provider
calling its `gates()` hook.

Order it **after** `AuthServiceProvider` (the gate resolves the current
user through `AUTH_TOKEN`), **before** `HttpServiceProvider` so
`GATE_TOKEN` is bound before routes referencing `can()` are collected, and
before any app provider whose `gates()` hook registers policies. See
[Service providers](../providers/).

## `GateRegistry`

| Method | Signature | Purpose |
|---|---|---|
| `define(ability, callback)` | `this` | Register a standalone ability not tied to a model. |
| `policy(model, policy)` | `this` | Register a policy class against a model class. |
| `before(callback)` | `this` | Runs before every check; may short-circuit. |
| `after(callback)` | `this` | Runs after a non-short-circuited check; may override. |
| `has(ability)` | `boolean` | Whether an ability name is defined. |
| `hasPolicy(model)` | `boolean` | Whether a model has a registered policy. |
| `allows(ability, ...args)` | `Promise<boolean>` | Check against the **ambient** user. |
| `denies(ability, ...args)` | `Promise<boolean>` | `!allows(...)`. |
| `authorize(ability, ...args)` | `Promise<void>` | Throws an `HttpError` when denied. |
| `abilitiesFor(abilities, model, row?)` | `Promise<Record<string, boolean>>` | Resolve several abilities at once. |
| `forUser(user)` | `UserGate` | A gate bound to an explicit user. |
| `check(user, ability, args)` | `Promise<boolean>` | The pipeline, boolean form, explicit user. |
| `inspect(user, ability, args)` | `Promise<AuthorizationResponse>` | The pipeline, full response, explicit user. |

Note the argument shape: `allows`/`denies`/`authorize` are **variadic**
(`...args`), while `check`/`inspect` take the args as an **array** plus an
explicit user. The variadic ones read the ambient scope and delegate.

`GateRegistry` is deliberately **not** a `Manager<T>`. There are no
swappable drivers here, and forcing the manager shape onto a single
concrete registry would be cargo-culting the pattern rather than using it.

## Policies

A policy is per-model authorization. Method names map to ability names
verbatim: `Gate.authorize("delete", Post, post)` calls `policy.delete(...)`
and nothing else. No snake_case/camelCase translation, so the mapping
stays greppable.

```ts
// app/src/policies/post.policy.ts
import { Policy, requireAuth } from "@mahiframework/authorization";
import type { UserTable } from "../models/user.model.js";
import type { PostTable } from "../models/post.model.js";

export class PostPolicy extends Policy<UserTable, PostTable> {
  view(): boolean {
    return true;
  }

  create = requireAuth<UserTable, []>(() => true);

  delete = requireAuth<UserTable, [PostTable]>((user, post) => post.user_id === user.id);
}
```

Every method takes the **user first**, and it is **nullable**,
unauthenticated requests reach policies too. The target row comes second.
Create-style abilities have no row yet, so they take just the user.

```ts
export type PolicyMethod<TUser = unknown, TRow = unknown> = (
  user: TUser | null,
  ...args: [row?: TRow, ...rest: unknown[]]
) => PolicyResult | Promise<PolicyResult>;
```

`PolicyResult` is `boolean | AuthorizationResponse`.

**Policies are stateless by contract.** They're instantiated once and
cached on the registry, so they must not hold per-request state, the same
contract as `Guard` in `@mahiframework/auth`, and for the same reason: one
long-lived `Application` serves every concurrent request.

### `requireAuth` and `requireGuest`

Two composable wrappers for the overwhelmingly common ways a policy method
handles guests, so they don't have to be hand-written (and occasionally
forgotten) in every method.

```ts
export class PostPolicy extends Policy<UserTable, PostTable> {
  // Guest-aware, written out by hand: `user` is nullable here.
  view(user: UserTable | null, post: PostTable): boolean {
    if (post.published) return true;
    return user !== null && post.user_id === user.id;
  }

  // Owner-only — `user` is non-null inside the callback.
  delete = requireAuth<UserTable, [PostTable]>((user, post) => post.user_id === user.id);

  // Guests only.
  register = requireGuest<[]>(() => true);
}
```

They're used as **class property initializers**, which is how a wrapper
composes with the class-based `Policy` shape.

`requireAuth` denies guests outright and hands the callback a guaranteed
non-null user. **The type narrowing is the point:** without it, every
owner-check body needs its own `user === null` branch, and the one that
gets forgotten is a null-dereference at best or an authorization bypass at
worst.

`requireGuest` is the mirror image, the callback never receives a user at
all, and authenticated users are denied.

Both styles behave identically at the call site. These are a convenience,
not required ceremony.

## Standalone abilities

Not everything is tied to a model:

```ts
gate.define("view-admin-panel", (user: UserTable | null) => user?.role === "admin");
```

```ts
await Gate.allows("view-admin-panel");
```

An `Ability` receives `(user, ...args)`, every argument you passed, with
no model-class stripping.

## Registration

Register explicitly via the `gates()` provider hook:

```ts
import type { GateRegistry } from "@mahiframework/authorization";

export class PostsServiceProvider extends ServiceProvider {
  gates(gate: GateRegistry): void {
    gate.policy(Post, PostPolicy);
    gate.define("view-admin-panel", (user) => user?.role === "admin");
  }
}
```

A single hook covers both policies and abilities rather than a separate
`policies()` returning tuples, matching `schedule(schedule: Schedule)`'s
shape (receive the registry, call methods on it) and avoiding the question
of what a provider does when it wants both.

The hook is declared by `@mahiframework/authorization` via TypeScript declaration
merging onto `@mahiframework/core`'s `ProviderHooks` interface, so it's typed on
every `ServiceProvider` subclass once the package is imported.

### There is no name-guessing convention

Laravel maps `Todo` → `TodoPolicy` by naming convention. Mahi does not,
because the TypeScript version of that trick is either **fragile**
(`SomeClass.name`, broken by minification) or **magic** (filesystem
scanning at boot). Registration is one line in a provider you already
have.

### The model is named by class, not by string

Rows in this framework are plain objects. `Model` reads return hydrated
instances, but a row passed to a policy is attribute data, and
`post instanceof Post` is not something the gate relies on. The model has
to be named at the call site:

```ts
await Gate.authorize("delete", Post, post);
//                              ^^^^ the class, as a value
```

A class reference is compile-checked and survives renames. A string would
fail **closed and silently** on a typo, because resolution is
fail-closed, a misspelled model name just falls through to "no such
ability" and denies. That is the worst failure mode an authorization
system can have, because it looks like it's working.

Dispatch keys off the policy registry by **exact identity** rather than
inspecting the argument's shape: model classes are ordinary constructor
functions, so there's no heuristic guessing about what "looks like" a
model.

`ModelClass` is typed `abstract new (...args: any[]) => unknown` so both
concrete models and abstract bases are assignable, deliberately not
`Function`, which would accept any callable at all and let
`gate.policy(someHelperFn, ...)` type-check.

## Resolution

Every entry point funnels through `inspect()`:

1. **`before()` hooks**, in registration order. A non-null result wins
   immediately and **skips `after()`**.
2. If `args[0]` is a model class **with a registered policy**, dispatch to
   `policy[ability](user, ...rest)`. A **missing method denies**.
3. Otherwise, a `define()`d ability, called with `(user, ...args)`.
4. Otherwise, **deny**.
5. **`after()` hooks**, which may override the result.

`check()` is the boolean form. It calls `inspect()` and collapses the
response to its `allowed` flag.

### Fail-closed, throughout

Steps 2 and 4 deny rather than throw. An unknown ability denies; a policy
missing the requested method denies. Neither is an error.

Throwing on an unknown ability would surface typos more loudly, but **a
typo that 403s in production is better than one that 500s**, and step 2
must not throw regardless, because policies legitimately implement only a
subset of abilities (`PostPolicy` has no `update`: posts aren't editable
once published).

Normalization is strict too. Only a literal `true` allows:

```ts
function normalize(result: PolicyResult): AuthorizationResponse {
  if (isAuthorizationResponse(result)) return result;
  return result === true ? AuthorizationResponse.allow() : AuthorizationResponse.deny();
}
```

A stray truthy non-boolean, a promise you forgot to `await`, an object,
the string `"yes"`, is treated as **denial**, not permission.

### `before()` / `after()`

`before()` is the documented seam for "superadmins can do anything".
Return `true`/`false` to decide immediately, `null` to fall through:

```ts
gate.before<UserTable>((user) => (user?.role === "admin" ? true : null));
```

`after()` runs on non-short-circuited checks and receives the result so
far:

```ts
gate.after<UserTable>((user, ability, result) => (result ? null : maybeOverride(user, ability)));
```

Both hooks speak **plain booleans** (plus `null` to abstain). Their
override semantics predate rich responses and are unchanged, only the
policy or ability body in the middle may return an
`AuthorizationResponse`.

## `AuthorizationResponse`

A policy method can return one of these instead of a bare boolean to
declare its **own** denial shape: a custom message, and a custom HTTP
status.

| Static | Result | `status` |
|---|---|---|
| `AuthorizationResponse.allow(message?)` | allowed |: |
| `AuthorizationResponse.deny(message?, status?)` | denied | `status`, or 403 at throw time |
| `AuthorizationResponse.denyAsNotFound(message?)` | denied | **404** (`message` defaults to `"Not Found"`) |

Instance members: `allowed` (readonly boolean), `message`, `status`, and
`denied()`. `isAuthorizationResponse(value)` is exported for narrowing.

```ts
import { AuthorizationResponse } from "@mahiframework/authorization";

export class BookmarkPolicy extends Policy<UserTable, BookmarkTable> {
  view(user: UserTable | null, bookmark: BookmarkTable): AuthorizationResponse {
    if (user !== null && bookmark.user_id === user.id) {
      return AuthorizationResponse.allow();
    }
    // Someone else's private row reads as missing, so the endpoint can't
    // be used to probe which ids exist.
    return AuthorizationResponse.denyAsNotFound();
  }
}
```

Without this, the "404 on reads" decision has to be hand-rolled
per-controller, **outside** the gate, because a policy method returning
`boolean` has no way to say "deny this as a 404".

`allows()` / `denies()` still collapse the result to a boolean. Only
`authorize()` (and `can()`, which routes through it) reads `status` and
`message` to shape the thrown error:

```ts
if (response.status === 404) throw HttpError.notFound(response.message);
if (response.status !== undefined && response.status !== 403) {
  throw new HttpError(response.status, response.message ?? "Forbidden");
}
throw HttpError.forbidden(response.message);
```

## 401 vs 403 vs 404

These lines are drawn deliberately, and mixing them up leaks information.

| Status | Meaning | Who produces it |
|---|---|---|
| **401** | No valid credentials. Authenticating differently could fix it. | `authenticate()` middleware |
| **403** | Authenticated, but not permitted. Different credentials won't help. | `authorize()` / `can()` on a plain deny |
| **404** | The row exists but isn't yours, and admitting it exists would leak. | `denyAsNotFound()` |

**404 on reads.** Someone else's private data, a bookmark list, a draft,
should read as missing, so the endpoint can't be used as an oracle for
which ids exist. If `GET /bookmarks/{id}` returns 403 for a real id
belonging to someone else and 404 for a nonexistent one, an attacker can
enumerate valid ids without ever reading their contents.

**403 on writes.** You already had to know the id to attempt the write,
deleting a post, for instance, so there's nothing left to leak, and a
404 would be actively misleading about *why* it failed.

**401 is not an authorization decision.** The gate never produces one. A
guest who reaches a policy gets denied (403), which is why routes that
require a user should carry `authenticate()`, so a missing credential
surfaces as "log in", not "you may not".

## Checking from a controller

Two call styles ship, and the choice is about whether you need the row
anyway.

### The `authorize()` helper

```ts
import { authorize } from "@mahiframework/authorization";

export class DeletePostController extends Controller {
  async handle(request: Request) {
    const existing = await request.model(Post);

    await authorize("delete", Post, existing);

    await Post.delete(existing.id);
    return HttpResponse.json({ deleted: true });
  }
}
```

Prefer this when the handler needs the row regardless, one query instead
of two, since `request.model()` caches on the instance.

Three free functions ship alongside it, all reading the ambient auth
scope and taking no `Context`:

| Function | Returns |
|---|---|
| `authorize(ability, ...args)` | `Promise<void>`: throws when denied |
| `allows(ability, ...args)` | `Promise<boolean>` |
| `denies(ability, ...args)` | `Promise<boolean>` |
| `gate()` | `GateRegistry`: the resolved singleton |

### The `can()` middleware

```ts
import { can } from "@mahiframework/authorization";

posts.post("/", CreatePostController)
  .middleware(authenticate(), can("create", Post));
```

```ts
can(
  ability: string,
  model?: ModelClass,
  resolve?: (request: Request) => unknown | Promise<unknown>,
): HttpPipe
```

The ability and model are static; the row, for abilities that operate on
one, comes from the optional resolver:

```ts
posts.delete("/{post}", DeletePostController)
  .middleware(authenticate(), can("delete", Post, (request) => request.model(Post)));
```

Prefer `can()` for uniform CRUD, where having the check visible in the
route table is genuinely valuable when auditing what protects an endpoint.

It goes through `gate.authorize()`, not a bare `allows()`, so a policy's
rich denial, a custom message, or `denyAsNotFound()`'s 404, is honoured
here too.

### Form requests

Authorization lives on the `Request` (Laravel-style). When a controller
declares `request = SomeRequest`, the framework runs `authorize()` first
and validation second, **authorize → 403, then validate → 422**:

```ts
// app/src/http/requests/create-post.request.ts
import { Request, rule, fileRule } from "@mahiframework/http";
import { authorize } from "@mahiframework/authorization";
import { Post } from "../../models/post.model.js";

export class CreatePostRequest extends Request {
  override authorize() {
    return authorize("create", Post);
  }

  rules() {
    return {
      body: rule().string().required().min(1).max(280),
      images: rule().array(fileRule().image().max(5120)).max(4).optional(),
    } as const;
  }
}
```

The ordering matters: a denied request 403s **before** any validation
runs, so an unauthorized caller never learns which fields the endpoint
accepts or what shape they take.

Two ways to signal denial from `authorize()`, and they differ:

- **Return `false`**: the controller pipeline throws a bare
  `HttpError.forbidden()` with no message.
- **`await authorize(...)`**: the gate throws, so a policy's custom
  message or `denyAsNotFound()` status survives.

`authorize()` defaults to allow, so requests that don't override it fall
straight through. See [Requests](../requests/#authorize) and
[Controllers](../controllers/).

## The `Gate` facade

A hand-written class with real static methods proxying `GATE_TOKEN`. The
class is `GateRegistry`; the facade is `Gate`, the name written at call
sites, mirroring how `Hash`/`Crypt` front `Hasher`/`Encrypter`.

| Static | Returns |
|---|---|
| `Gate.allows(ability, ...args)` | `Promise<boolean>` |
| `Gate.denies(ability, ...args)` | `Promise<boolean>` |
| `Gate.authorize(ability, ...args)` | `Promise<void>` |
| `Gate.forUser(user)` | `UserGate` |
| `Gate.abilitiesFor(abilities, model, row?)` | `Promise<Record<string, boolean>>` |

The user is implicit, read from `@mahiframework/auth`'s `AsyncLocalStorage` scope.

## Authorizing without a request

Queue jobs, CLI commands, and tests have no ambient auth scope.
`forUser()` is the supported way to authorize anyway:

```ts
await Gate.forUser(someUser).allows("delete", Post, post);
await Gate.forUser(someUser).authorize("delete", Post, post);
await Gate.forUser(null).allows("view", Post, post);      // as a guest
```

`UserGate` carries `allows()`, `denies()`, and `authorize()`, the same
three, bound to an explicit user, bypassing the ambient scope entirely.

The alternative is `Auth.runAs()`, which establishes a real scope so
`Gate.allows()` *and* `Auth.user()` both work inside it. Use `forUser()`
when you only need the gate; use `runAs()` when the code under test also
reads the current user.

Note what the gate does **not** do: `currentUser()` returns `null` when
`AUTH_TOKEN` isn't bound at all, so a gate works in an app with no
authentication (every check sees a guest). But it does **not** swallow
`MissingAuthContextError`, being outside a request scope entirely is a
programming error that should surface, and `forUser()` is the supported
way to authorize without one.

## Telling the frontend what a user can do

A detached frontend needs to know whether to render the delete button.
`abilitiesFor()` resolves several abilities for one target at once so it
doesn't have to replicate policy logic client-side:

```ts
const can = await Gate.abilitiesFor(["update", "delete"], Post, post);
// → { update: true, delete: false }
```

Internally it resolves the ambient user **once** and runs the checks in
parallel with `Promise.all`, so N abilities cost one user resolution.

### The `abilitiesFor` pattern

Put the ability list next to the policy that implements it, so the two
can't drift:

```ts
// app/src/policies/post.policy.ts
export class PostPolicy extends Policy<UserTable, PostTable> {
  view(): boolean {
    return true;
  }

  create = requireAuth<UserTable, []>(() => true);

  delete = requireAuth<UserTable, [PostTable]>((user, post) => post.user_id === user.id);
}

/** The abilities `PostResource` reports to the frontend via its `can` block. */
export const POST_ABILITIES = ["delete"] as const;
```

The model exposes a `can()` method returning the map:

```ts
// app/src/models/post.model.ts
export class Post extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
  keyType: "uuidv7",
  softDeletes: true,
}) {
  // ...

  async can(): Promise<Record<(typeof POST_ABILITIES)[number], boolean>> {
    return Gate.abilitiesFor([...POST_ABILITIES], Post, this.toObject()) as Promise<
      Record<(typeof POST_ABILITIES)[number], boolean>
    >;
  }
}
```

Three details in those four lines:

**It's a plain async instance method, not a serialized model attribute.**
Shaping the wire format is the [API resource](../responses/)'s job, not
the model's. `PostResource` calls `await post.can()` inside its own
`async toJson()` and embeds the result as a `can` block.

**It passes `toObject()`, not `this`.** The policy only needs the row
data, and handing it a plain object keeps it independent of the model
class. (Reading `this.user_id` inside the method works fine, the
attribute proxy binds `this` to the receiver, so this is a choice about
the policy's interface, not a workaround.)

**The return type is derived from `POST_ABILITIES`.** `Record<(typeof
POST_ABILITIES)[number], boolean>` is `{ delete: boolean }`. Adding
`"update"` to the const array widens the type, and any consumer destructuring
a missing key is a compile error rather than a runtime `undefined`.

The wire result:

```json
{
  "id": "427185966743560456",
  "body": "hello",
  "can": { "delete": true }
}
```

### It is a rendering hint only

The `can` block tells the UI what to draw. **It enforces nothing.** The
API re-checks every write through `authorize()` or `can()`. That is what
actually protects anything. A client that ignores the block and issues the
`DELETE` anyway gets a 403 from the policy, not a successful delete.

## Related

- [Authentication](../authentication/): who the user is, `authenticate()`, `Auth.runAs()`
- [Requests](../requests/): form requests and their `authorize()` hook
- [Controllers](../controllers/): the authorize → validate → handle pipeline
- [Responses](../responses/): API resources, where the `can` block is shaped
- [Routing](../routing/): attaching `can()` to a route
- [Service providers](../providers/): the `gates()` hook and boot ordering
- [Models](../models/): `toObject()`, the casting proxy
