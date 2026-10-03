# Impersonation

`@mahiframework/impersonation` lets one user act as another: an admin
starts impersonating, works as that user for a while, and stops.

```ts
import { Impersonation } from "@mahiframework/impersonation";

// once, in a provider's boot()
Impersonation.authorize<User>((admin, user) => admin.isSuperadmin() && !user.isSuperadmin());

// in a route
await Impersonation.start(request, user);
await Impersonation.stop(request);
```

**Installing the package grants nobody anything.** The gate defaults to
deny-all, so until an app calls `authorize()`, every attempt is refused.
That is the opposite of convenient and the only safe default for a feature
whose whole purpose is bypassing authentication.

**The HTTP routes are opt-in.** Omit `impersonation.routes` from config and
the package contributes only the manager, the model and the migration — an
app drives it from its own controllers, behind its own middleware, with its
own logging and response shapes, while still going through the same gate.

**Session guards only.** Impersonation works by logging in as someone else,
and a `TokenGuard` deliberately has no `login()`: a bearer token is minted
out of band, so there is nothing to swap. `start()` throws
`NotStatefulGuardError` against one. `canImpersonate()` is guard-agnostic,
which is what lets a token-based app build its own flow on the same gate.

## Setup

`ImpersonationServiceProvider` binds an `ImpersonationManager` singleton at
`IMPERSONATION_TOKEN`, owns the `impersonations` table, and registers the
start/stop routes when `impersonation.routes` is configured.

Order it **after** `AuthServiceProvider` (the manager resolves `AUTH_TOKEN`,
and `authenticate()` on the routes needs it bound) and **before**
`HttpServiceProvider`, so the `routes()` hook is collected when the kernel
walks the providers. The same slot `AuthorizationServiceProvider` occupies.

```ts
// config/app.ts
export const providers: ServiceProviderClass[] = [
  // ...
  AuthServiceProvider,
  AuthorizationServiceProvider,
  ImpersonationServiceProvider,
  // ...
  HttpServiceProvider,
];
```

Then run the migration (`./artisan migrate`) and schedule the sweep
alongside `auth:gc`:

```ts
schedule.call(async (app) => {
  await new ImpersonationGcCommand(app).handle();
}).daily().name("impersonation-gc").withoutOverlapping();
```

## Defining who may impersonate

Register the gate once, from a provider's **`boot()`** — not `register()`,
which runs before other providers have bound anything:

```ts
// src/providers/app.provider.ts
boot(): void {
  Impersonation.authorize<User>((admin, user) =>
    admin.isSuperadmin() && !user.isSuperadmin());
}
```

The callback receives the admin and the target, in that order, and may be
async. Both users are non-nullable: a guest has no identity to impersonate
*as*, so unlike a `Gate` ability there is no `null` arm to handle.

`authorize()` **replaces** any previous gate; last call wins. There is one
answer to "who may impersonate", and an appending registry would make that
answer depend on provider order — not something anyone should have to
reason about to know who can log in as whom. Register it once, in one
provider, and use `before()` to add further conditions.

### `before()` hooks

A `before()` hook runs after the gate has already allowed, and can only
ever narrow. Deny by **throwing**:

```ts
Impersonation.before(() => Mfa.requireVerification("auth"));

Impersonation.before((admin, user) => {
  if (user.isLocked()) {
    throw new Error("Locked accounts cannot be impersonated.");
  }
});
```

Throwing rather than returning `false` is what lets an existing guard drop
in with no adapter — that `Mfa` call already throws — and what lets a hook
raise a 401-with-challenge that reaches the client **as itself** rather
than being flattened into a 403. Hook errors propagate exactly as thrown.

All hooks run, in registration order, and any one may deny. A literal
`false` return also denies, because TypeScript's void-assignability rule
accepts a boolean-returning arrow where `void` is declared, so
`before((a, u) => a.id !== u.id)` compiles and silently allowing it would
be a security bug rather than a surprise.

## `ImpersonationManager`

| Method | Signature | Purpose |
|---|---|---|
| `authorize(cb)` | `this` | Define the gate. Replaces any previous one. |
| `before(cb)` | `this` | Add a veto. Appended; throw to deny. |
| `hasGate()` | `boolean` | Whether a gate has been registered. |
| `canImpersonate(admin, user)` | `Promise<boolean>` | Self-check + gate. **Runs no hooks.** |
| `assertCanImpersonate(admin, user, request?)` | `Promise<void>` | Everything, including hooks. Throws. |
| `start(request, user, opts?)` | `Promise<ImpersonationRecord>` | Authorize, then begin. |
| `stop(request)` | `Promise<ImpersonationRecord \| null>` | Unwind one link. `null` when idle. |
| `current(request)` | `Promise<ImpersonationRecord \| null>` | The live link. Cached per-request. |
| `isImpersonating(request)` | `Promise<boolean>` | `current() !== null`. |
| `impersonator(request)` | `Promise<TUser \| null>` | Who started the *current* link. |
| `rootImpersonator(request)` | `Promise<TUser \| null>` | The real human at the top. |
| `chain(request)` | `Promise<ImpersonationRecord[]>` | The whole chain, root first. |
| `gc()` | `Promise<number>` | Delete lapsed links. |

### `canImpersonate()` versus `assertCanImpersonate()`

The split exists because hooks have side effects — an MFA hook *prompts*.

Use **`canImpersonate()`** to render: it runs no hooks, so it is safe
behind an "Impersonate" button's disabled state. Use
**`assertCanImpersonate()`** to guard the action: it runs the chain rules
and every hook, and throws.

Consequently `canImpersonate()` returning `true` is **not** a guarantee
that `start()` will succeed. A hook may still veto, and the depth rules
need the request.

## Rolling your own routes

Omit `impersonation.routes` and wire it up yourself. The gate and the hooks
still apply, because they live on the manager:

```ts
export class ImpersonateController extends Controller {
  async handle(request: Request) {
    const target = await User.findOrFail(request.route("user"));

    // Throws ImpersonationDeniedError (a 403) when refused.
    await Impersonation.start(request, target);

    await AuditLog.record("impersonation.start", { target: target.id });

    return HttpResponse.json({ ok: true });
  }
}
```

For a read-only check, say to decorate an API response:

```ts
const canImpersonate = await Impersonation.canImpersonate(Auth.user<User>(), target);
```

## The built-in routes

Set `impersonation.routes` (even to `{}`) and two routes are registered,
both behind `authenticate()`:

| Route | Name | Purpose |
|---|---|---|
| `POST /impersonate/{user}` | `impersonation.start` | Begin impersonating. |
| `DELETE /impersonate` | `impersonation.stop` | End the current impersonation. |

`DELETE` rather than `POST .../stop`: the impersonation is a resource, and
stopping deletes it.

```ts
// config/impersonation.ts
export function impersonationConfig(): ImpersonationConfig {
  return {
    routes: {}, // omit this key entirely to register no routes
    maxDepth: 1,
  };
}
```

| Option | Default | Purpose |
|---|---|---|
| `routes` | *(absent)* | Presence registers the routes. |
| `routes.prefix` | `/impersonate` | Path they mount under. |
| `routes.guard` | the auth default | Which (stateful) guard to use. |
| `routes.parameter` | `user` | Route parameter carrying the target. |
| `maxDepth` | `1` | How many links may nest. |

Key presence is the switch rather than `routes: { enabled: false }`,
matching `http.liveness` and `http.healthCheck`. In this framework an
opt-in feature gates on its key existing; only on-by-default behaviour
uses an `enabled` flag.

### Stopping is never authorized

`stop()` runs no gate and no hooks. You are, at that moment, the
impersonated user, and re-checking permission to leave is how an admin
gets trapped inside someone else's account after their own access is
revoked mid-session. Possession of the row is the authorization.

## Nested impersonation

`maxDepth: 2` lets Bob impersonate Alice and then Alice-as-Bob impersonate
Jane. The use case is real: a platform admin impersonating a tenant admin
who needs to see what one of *their* users sees.

```
Bob → start(Alice) → start(Jane)
  stop()  // back to Alice, still impersonating, depth 1
  stop()  // back to Bob, done
```

Each `stop()` unwinds exactly one link. `impersonator()` returns whoever
started the innermost link (Alice, above), while `rootImpersonator()`
returns the real human (Bob) whatever the depth — that is the one to log.

Values `<= 0` are normalised to **1**, not treated as "disabled". A
configured `0` can only mean "nobody may impersonate", which is already the
default gate's job and is better said by not registering the provider.
Honouring it would make an app that typo'd a `0` present as impersonation
inexplicably never working, with a gate callback that looks correct.

Impersonating someone already in the chain is refused
(`already-in-chain`), as is impersonating yourself (`self`).

## Events

`ImpersonationStarted` and `ImpersonationFinished` carry the record plus
both resolved users, so a listener need not re-fetch what every listener
wants:

```ts
listeners(): ReadonlyArray<ListenerRegistration> {
  return [[ImpersonationStarted, LogImpersonation]];
}
```

Dispatch is a soft dependency: an app with no `EventsServiceProvider` gets
working impersonation and no events.

`ImpersonationFinished` fires on `stop()` only, **not** when an
impersonation merely lapses. Nothing observes that moment except the gc
command, and firing a "finished" event from a cron hours later would
misreport when it happened and hand listeners a request-less context they
cannot act in. The command reports a count instead.

## Denials

`ImpersonationDeniedError` extends `HttpError` with status 403, so it
renders correctly from a hand-rolled route that never imported it, while
staying `instanceof`-checkable. Its `reason` is one of:

| Reason | Meaning |
|---|---|
| `not-authorized` | The gate said no, or no gate is registered, or a hook returned `false`. |
| `self` | Admin and target are the same user. |
| `max-depth` | The chain is already `maxDepth` deep. |
| `already-in-chain` | The target is already in the current chain. |

The reason is carried so a logging hook can tell "an admin attempted
something they are not permitted to do" from "an admin double-clicked",
which are not the same signal.

`ImpersonatorMissingError` (409) is thrown by `stop()` when the
impersonator's account was deleted during the impersonation. The built-in
controller catches it and logs the session out entirely: leaving it
authenticated as the impersonated user would silently convert a deleted
admin's impersonation into a permanent, unaudited login to someone else's
account.

## What to know before shipping this

**An impersonated session can do everything the target can**, including
change their password and delete their account. This package does not
restrict abilities; that is your `Gate`, your policies, and your `before()`
hooks. If impersonation should be read-mostly, enforce that yourself.

**The admin's session id rotates twice** — once on `start()`, once on
`stop()`. `SessionGuard.login()` always mints a fresh id and destroys the
old one, which is its session-fixation defence. Remember-me *is* restored
by `stop()`, but its clock restarts: an admin 300 days into a remembered
session gets a fresh 400, not the remaining 100.

**The impersonated user is not logged out.** Their own sessions, on their
own devices, are untouched.

**A revoked admin keeps their impersonation** until it lapses or they stop,
because the impersonation *is* the live session. Deleting their other
sessions does not touch it. Delete the `impersonations` row to revoke
immediately — that revocability is why the chain lives in a table rather
than a cookie.

## See also

- [Authentication](../authentication/): guards, sessions, remember-me
- [Authorization](../authorization/): gates and policies for what the
  impersonated session may actually do
- [Providers](../providers/): where to register the gate
- [Routing](../routing/): the opt-in routes
- [Console](../console/): `./artisan impersonation:gc`
