# Authentication

`@mahiframework/auth` answers *"who is making this request"*. It has two built-in
guards (bearer tokens, cookie sessions), one built-in user provider
(database-backed), and a per-request identity scope built on
`AsyncLocalStorage` rather than a request-scoped container.

```ts
import { Auth } from "@mahiframework/auth";

const user = Auth.user<UserTable>();       // throws for guests
const maybe = Auth.userOrNull<UserTable>();// null for guests
if (Auth.check()) { /* ... */ }
```

Authentication is the *identity* half. The *permission* half,
"may this user do this to this thing", lives in
[Authorization](../authorization/).

Second factors are a separate package. `@mahiframework/auth` has no TOTP,
no one-time codes and no step-up re-verification; those are in
[Multi-factor auth](../mfa/), which an app installs when it wants them.

## Configuration

`config/auth.ts` returns an `AuthConfig`:

```ts
export interface AuthConfig {
  default: string;
  guards: Record<string, unknown>;
  providers: Record<string, unknown>;
  passwords?: PasswordBrokerConfig & { provider?: string };
  verification?: EmailVerificationConfig & { provider?: string; model?: unknown };
  /** Read by the SCAFFOLDED controllers, not by the framework. */
  notifications?: { resetPassword?: boolean; verifyEmail?: boolean };
}
```

The base app ships this:

```ts
// config/auth.ts
import type { AuthConfig } from "@mahiframework/auth";
import { User } from "../src/models/user.model.js";
import type { Env } from "./env.js";

export function authConfig(env: Env): AuthConfig {
  return {
    default: "token",

    guards: {
      token: {
        provider: "users",
        expiresInMinutes: null,   // null = never expires, matching Sanctum
      },
      session: {
        provider: "users",
        store: "database",
        cookie: "session",
        lifetimeMinutes: 120,
        sameSite: "Lax",
        secure: env.NODE_ENV === "production",
        path: "/",
      },
    },

    providers: {
      users: {
        driver: "database",
        model: User,
        identifierColumn: "email",
        passwordColumn: "password",
      },
    },
  };
}
```

`guards` and `providers` are typed as `Record<string, unknown>` because
each driver reads its own config shape: `TokenGuardConfig`,
`SessionGuardConfig`, `DatabaseUserProviderConfig`. The manager hands the
raw object to the factory, which casts it.

### Which guard to use

This is topology-dependent, not a preference:

**`token`**, bearer tokens in an `Authorization` header. Correct for a
detached frontend (a SPA on another origin) and for any third-party API
consumer. Needs no CSRF protection, because browsers never attach an
`Authorization` header automatically.

**`session`**, a signed cookie plus a server-side session. Correct when
the frontend is served from the **same origin** as the API. Cross-origin
cookies require `sameSite: "None"` **and** `secure: true`, and `secure`
means they will not work over plain HTTP, so a cross-origin SPA in local
development silently gets no session at all. That is a browser rule, not
a framework limitation. Pair this guard with the [`csrf()`](#csrf)
middleware.

If you're building an API that a mobile app or a separately-deployed SPA
consumes, use `token` and stop reading this paragraph. If you're serving
HTML and JSON from one origin, `session` gives you revocable server-side
sessions and httpOnly cookies.

### Provider registration

`AuthServiceProvider` must come **after** `DatabaseServiceProvider` (user
lookups and its own tables), **after** `EncryptionServiceProvider`
(`HASHER_TOKEN` for passwords, `SIGNER_TOKEN` for session cookies),
**after** `CacheServiceProvider` if you use the `cache` session store, and
**before** `HttpServiceProvider` so `AUTH_TOKEN` is bound and the global
auth-scope pipe is collected before routes and middleware are. See
[Service providers](../providers/).

## The two driver axes

`Manager<T>` models one swappable-driver axis. Auth genuinely has two,
and they're orthogonal:

| Axis | What it decides | Registered with | Resolved with |
|---|---|---|---|
| **Guard** | How a request is authenticated | `manager.extend(name, factory)` | `manager.guard(name)` / `driver(name)` |
| **User provider** | Where users come from | `manager.extendUserProvider(driver, factory)` | `manager.userProvider(key)` |

Guards go through the inherited `Manager` machinery. User providers get a
small parallel registry on `AuthManager`. That split is deliberate:
widening `Manager<T>` to support two axes would complicate every other
manager in the framework for one caller's benefit.

The two axes compose. Both built-in guards share one user provider, so
swapping SQLite for an external identity service means writing one
`UserProvider` and changing one config line, neither guard changes.

`AuthServiceProvider` registers the built-ins through exactly the same
public methods a plugin would use:

```ts
manager.extendUserProvider("database", (app, config) =>
  new DatabaseUserProvider(config as DatabaseUserProviderConfig, hasher));

manager.extend("token", () => {
  const guardConfig = manager.guardConfig("token") as TokenGuardConfig;
  return new TokenGuard(manager.userProvider(guardConfig.provider), guardConfig);
});
```

Note the asymmetry in how they're named: `extendUserProvider()` registers
a **driver** (`"database"`), but `userProvider()` resolves by **config
key** (`"users"`), matching how `config/auth.ts` names them. Passing a
driver name to `userProvider()` throws `UnknownUserProviderError`;
naming a config entry whose `driver` was never registered throws
`UserProviderNotRegisteredError`.

### Writing a custom guard

A `Guard` is one method:

```ts
export interface Guard<TUser = unknown> {
  user(request: Request): Promise<TUser | null>;
}
```

Deliberately one method. Laravel's guard also carries
`check()`/`guest()`/`id()`, but those are pure derivations of `user()`.
They live on `AuthManager` and the `Auth` facade instead.

**Guards are stateless by contract.** A guard is a long-lived singleton
shared across every concurrent request (one `Application`, resolved once
by `AuthManager`), so it must never memoize per-request state on itself.
Everything it needs comes from the `Request` argument; the resolved user
goes into the ambient scope.

```ts
export class ApiKeyServiceProvider extends ServiceProvider {
  boot(): void {
    const auth = this.app.make<AuthManager>(AUTH_TOKEN);

    auth.extend("api-key", (app) => new ApiKeyGuard(auth.userProvider("users")));
  }
}
```

### Writing a custom user provider

```ts
export interface UserProvider<TUser = unknown> {
  retrieveById(id: string): Promise<TUser | null>;
  retrieveByCredentials(credentials: Credentials): Promise<TUser | null>;
  validateCredentials(user: TUser, credentials: Credentials): Promise<boolean>;
  updatePassword?(user: TUser, hashedPassword: string): Promise<void>;
}
```

The split between `retrieveByCredentials()` (look up, don't check the
secret) and `validateCredentials()` (check the secret) is intentional.
Do not "simplify" it into one `findByCredentials` that checks the password
too, keeping lookup and verification separate is what lets
[`attempt()`](#attempt) perform constant work when no user was found, so
response timing doesn't leak whether an account exists.

`updatePassword()` is optional because not every user source is writable.
`PasswordBroker.reset()` requires it and throws loudly if the configured
provider doesn't implement it, rather than silently no-op'ing a password
change.

## `AuthManager`

Bound as a singleton at `AUTH_TOKEN`.

| Method | Returns | Purpose |
|---|---|---|
| `guard<TUser>(name?)` | `Guard<TUser>` | Resolve by **config name**. Defaults to `config.default`. |
| `statefulGuard<TUser>(name?)` | `StatefulGuard<TUser>` | Same, but typed with `login()`/`logout()`; throws if the guard has none. |
| `guardConfig(name?)` | `Record<string, unknown>` | The raw config object for a guard. `{}` if absent. |
| `guardDriver(name?)` | `string` | The driver a named guard uses. |
| `login(request, userId, opts?)` | `Promise<string>` | Log a user in through a stateful guard. |
| `attemptLogin<TUser>(request, credentials, opts?)` | `Promise<TUser \| null>` | Verify **and** log in, Laravel's `Auth::attempt()`. |
| `logout(request, guardName?)` | `Promise<void>` | End the current session. |
| `collectableGuards()` | `Array<[string, { gc() }]>` | Guards that can sweep their own expired rows. Drives `auth:gc`. |
| `extend(driver, factory)` | `this` | Register a guard **driver**. |
| `extendUserProvider(driver, factory)` | `this` | Register a user-provider driver. |
| `userProvider(name?)` | `UserProvider` | Resolve a configured provider by **config key**. Cached. |
| `passwordBroker()` | `PasswordBroker` | The single reset broker. Cached. |
| `resolve(request, guardName?)` | `Promise<unknown \| null>` | Authenticate the request and write the result into the ambient scope. |
| `user<TUser>()` | `TUser` | Ambient user. Throws for guests. |
| `userOrNull<TUser>()` | `TUser \| null` | Ambient user, or `null` for guests. |
| `check()` | `boolean` | Whether anyone is authenticated in this scope. |
| `currentGuard()` | `string \| null` | The guard that resolved the current user. |
| `id()` | `string` | `String(user.id)`. Throws for guests. |
| `runAs(user, fn)` | `Promise<T>` | Run `fn` in an explicit auth scope. |
| `attempt<TUser>(credentials, providerName?)` | `Promise<TUser \| null>` | Verify credentials. Does **not** log anyone in. |

`resolve()` mutates the state opened by `AuthServiceProvider`'s global
pipe rather than nesting a new scope, so one request has exactly one
identity for its whole lifetime. `authenticate()` calls it and 401s on
`null`.

`id()` assumes an `id` property, which is the convention every model in
this framework already follows (a model's `primaryKey` config defaults to
`"id"`).

### Guards are named, and resolved by driver

Guards are the one place `AuthManager` diverges from `Manager`'s
name-equals-driver assumption, because auth's config genuinely has two
layers:

```ts
guards: {
  web:   { driver: "session", provider: "users" },
  admin: { driver: "session", provider: "users", cookie: "admin_session" },
  api:   { driver: "token",   provider: "users" },
}
```

Factories are registered by **driver** (`extend("session", ...)`), while
resolved instances are cached by **name**, so `guard("web")` and
`guard("admin")` are two independently configured session guards, and
each factory sees its own settings when it calls `guardConfig()` with no
argument.

The framework's own shorthand still works: when a guard block has no
`driver` key, the name *is* the driver, so `{ session: { ... } }`
resolves the session driver as before.

## The `Auth` facade

A hand-written class with real static methods proxying one token. See
the [facades note](../README.md#design-principles) for why this is a
narrow exception rather than a reversal of "no dynamic facades".

| Static | Forwards to |
|---|---|
| `Auth.user<TUser>()` | `manager.user()` |
| `Auth.userOrNull<TUser>()` | `manager.userOrNull()` |
| `Auth.check()` | `manager.check()` |
| `Auth.id()` | `manager.id()` |
| `Auth.currentGuard()` | `manager.currentGuard()` |
| `Auth.attempt<TUser>(credentials, providerName?)` | `manager.attempt()` |
| `Auth.attemptLogin<TUser>(request, credentials, opts?)` | `manager.attemptLogin()` |
| `Auth.login(request, userId, opts?)` | `manager.login()` |
| `Auth.logout(request, guardName?)` | `manager.logout()` |
| `Auth.guard<TUser>(name?)` | `manager.guard()` |
| `Auth.statefulGuard<TUser>(name?)` | `manager.statefulGuard()` |
| `Auth.passwordBroker()` | `manager.passwordBroker()` |
| `Auth.runAs(user, fn)` | `manager.runAs()` |

Logging in and out needs no cast:

```ts
await Auth.login(request, user.id, { remember: true });
await Auth.logout(request);
```

`Auth.guard()` returns the `Guard` interface (one method). To reach a
concrete guard's own API you cast:

```ts
const guard = Auth.guard("token") as TokenGuard<UserTable>;
const { token } = await guard.createToken(user.id, "login");
```

For the session-establishing half, prefer `statefulGuard()` over a cast.
It is checked, so a guard that can't log anyone in fails with a clear
`NotStatefulGuardError` rather than a `TypeError` deep inside a handler:

```ts
const guard = Auth.statefulGuard("web");   // typed with login()/logout()
await guard.login(request, user.id);
```

## The auth context

Laravel's guard is request-scoped and stateful. `Auth::user()` works
because PHP rebuilds the container per request. Mahi boots **one**
long-lived `Application` and serves every request from it, so a singleton
holding "the current user" would leak one request's user into another.
That is a critical security bug, not a stylistic difference.

`AsyncLocalStorage` gives per-request isolation without per-request
container rebuilds, and propagates across `await` boundaries. The stored
value is:

```ts
export interface AuthState {
  user: unknown | null;
  guard: string | null;
}
```

Mutable, because `resolve()` writes into the state object opened by the
global pipe rather than nesting a second scope.

### Three cases, deliberately not collapsed into two

| Situation | `user()` | `userOrNull()` |
|---|---|---|
| **No scope**: queue job, CLI command, forgot the provider | `MissingAuthContextError` | `MissingAuthContextError` |
| **In scope, nobody authenticated** | `UnauthenticatedError` | `null` |
| **In scope, authenticated** | the user | the user |

**`userOrNull()` throwing on a missing scope is the important row**, and
the easiest thing to "helpfully" soften into returning `null`. Don't: a
route that forgot `authenticate()` must fail loudly rather than silently
behaving as an anonymous request, because "silently anonymous" is exactly
how authorization checks get bypassed. Only "we're in a request and
nobody is logged in" is a legitimate `null`.

### Every request gets a scope

`AuthServiceProvider.middleware()` contributes one global pipe that opens
an **empty** scope for every request:

```ts
middleware(): HttpPipe[] {
  return [(request, next) => runWithAuth({ user: null, guard: null }, () => next(request))];
}
```

So on a public route with no `authenticate()` middleware at all,
`Auth.userOrNull()` returns `null` rather than throwing, and
`MissingAuthContextError` stays reserved for genuinely non-HTTP callers.

### Outside a request

Queue jobs, CLI commands, and scheduled tasks have **no scope**. Any
`Auth.user()` / `Auth.userOrNull()` / `Auth.check()` call from one throws
`MissingAuthContextError` with a message pointing at the fix:

```ts
await Auth.runAs(user, async () => {
  // Auth.user() works here; Gate checks see this user too.
  await sendDigest();
});
```

`runAs()` sets `guard: null`. There was no guard involved, so
`Auth.currentGuard()` reports `null` even though `Auth.check()` is `true`.

`Request.user<TUser>()` is a thin delegate to `Auth.userOrNull()` that
returns `undefined` when `@mahiframework/auth` isn't bound at all. It exists so
framework code (a rate-limiter key callback, for instance) can ask
without a hard dependency on the auth package, prefer `Auth.user()` /
`Auth.id()` in your own controllers. See
[Requests](../requests/#the-current-user).

### Low-level exports

For code that needs the primitives rather than the facade,
`@mahiframework/auth` exports them directly: `runWithAuth`, `currentAuthState`,
`requireAuthState`, `user`, `userOrNull`, `check`, `currentGuard`,
`MissingAuthContextError`, `UnauthenticatedError`.

`currentAuthState()` returns `AuthState | undefined` (no throw);
`requireAuthState()` throws `MissingAuthContextError`. Both are for
guards and middleware that need to *write* to the state.

## Middleware

### `authenticate(guardName?)`

Resolves the user with the named guard (or the default) and throws
`HttpError.unauthorized()`, a 401, if there is none.

```ts
posts.post("/", CreatePostController).middleware(authenticate());
admin.get("/", DashboardController).middleware(authenticate("session"));
```

Per-route, not a global pipe: auth is opt-in per route.

### `authenticateOptional(guardName?)`

Resolves the user if credentials are present, never rejects. For routes
that serve guests and authenticated users differently:

```ts
router.group("/posts", (posts) => {
  posts.middleware(authenticateOptional());

  posts.get("/", ListPostsController).name("posts.index");
  posts.get("/{post}", GetPostController).name("posts.show");
  posts.post("/", CreatePostController)
    .middleware(authenticate(), throttle("create-post"))
    .name("posts.store");
});
```

Pair it with `Auth.userOrNull()`. `Auth.user()` still throws for guests,
by design.

### `ensureEmailVerified(column?)`

Requires the authenticated user's `email_verified_at` to be set, else
403. **Place it after `authenticate()`**: it reads the user that
`authenticate()` resolved into the ambient scope, and does not resolve
anyone itself:

```ts
protectedRoutes.get("/", handler).middleware(authenticate(), ensureEmailVerified());
```

A guest (no user in scope) gets a 401, not a 403, authenticating
differently could fix a 401; different credentials won't fix a 403.

There is no redirect branch (unlike Laravel's dual API/web
`EnsureEmailIsVerified`): this is an API-only framework, so an unverified
user is a flat 403.

### `csrf(options?)`

Signed double-submit-cookie CSRF protection.

```ts
import { csrf } from "@mahiframework/auth";

router.group("/app", (routes) => {
  routes.middleware(csrf(), authenticate("session"));
  // ...
});
```

| Option | Default | Meaning |
|---|---|---|
| `cookie` | `"XSRF-TOKEN"` | Cookie holding the token |
| `header` | `"X-XSRF-TOKEN"` | Header the client echoes it back in |
| `field` | `"_token"` | Form field checked when the header is absent; `null` to disable |
| `sign` | `true` when a `Signer` is bound | HMAC the cookie so forged tokens are rejected |
| `prefix` |: | `"host"` for a `__Host-` cookie a sibling subdomain can't write |
| `secure` | `true` | Adds `Secure` to the cookie |
| `sameSite` | `"Lax"` | Cookie `SameSite` |
| `path` | `"/"` | Cookie `Path` |
| `safeMethods` | `["GET","HEAD","OPTIONS"]` | Methods that skip the check |

`GET`, `HEAD`, and `OPTIONS` are treated as safe and pass through
unchecked (they still get the cookie issued). Every other method must
present the token in the header **or** the form field, compared with
`timingSafeEqual`. A mismatch is
`HttpError.forbidden("CSRF token mismatch.")`.

The form-field fallback is what makes this usable from a plain HTML
form: a client with no JavaScript cannot set a request header at all, so
a header-only check silently restricts the app to `fetch`/XHR callers.

#### The cookie is signed, and why that matters

The cookie value is `<token>.<hmac>`, produced with the app's `Signer`.
A cookie whose signature doesn't verify is discarded and re-issued
rather than trusted.

Plain double-submit accepts *any* value that appears in both the cookie
and the header. So an attacker who can **write** a cookie, an XSS on a
sibling subdomain, or a MITM on plain HTTP, which can set cookies for the
HTTPS origin, simply picks both halves and forges at will. Signing means
only tokens this server minted count.

This is **not** Laravel/Sanctum's synchronizer token. Laravel binds the
token to the *session*, so a token is useless in anyone else's. This is
per-cookie, which is strictly weaker against an attacker who can write
cookies to the victim's browser. To close that gap, serve over HTTPS and
set `prefix: "host"`, a `__Host-` cookie cannot be set or overwritten by
a sibling subdomain, and treat `SameSite=Lax` (the default) as the
primary defense.

**The cookie is deliberately not `httpOnly`.** The whole mechanism
depends on the client's JavaScript being able to read the cookie and copy
it into a request header. An attacker's page on another origin can cause
the browser to *send* the cookie but cannot *read* it (same-origin
policy), so it cannot construct the matching header. Making the cookie
`httpOnly` would break the scheme entirely, not harden it.

The cookie is queued on the `Request` (`request.queueCookie(...)`) and
written by the HTTP boundary, not set through Hono. See
[The cookie is queued, not set through Hono](#the-cookie-is-queued-not-set-through-hono).

**The token guard needs no CSRF middleware.** CSRF exists because
browsers attach cookies to cross-origin requests automatically. They
never attach an `Authorization` header automatically, so there is nothing
for an attacker's page to ride on. Adding `csrf()` to a token-guarded API
buys nothing and breaks non-browser clients.

## Verifying credentials

`Auth.attempt()` verifies credentials and returns the user or `null`. It
does **not** log anyone in, the caller decides what to issue (a token, a
session):

```ts
const user = await Auth.attempt<UserTable>({ email: body.email, password: body.password });

if (user === null) {
  throw HttpError.unauthorized("Invalid credentials.");
}
```

### The dummy hash

When no user matches, `attempt()` still hashes the submitted password and
discards the result:

```ts
if (user === null) {
  await this.hasher.make(credentials["password"] ?? "");
  return null;
}
```

argon2 takes on the order of 50–100ms. Without this line, "no such
account" returns almost instantly while "wrong password" takes ~100ms,
and an attacker can enumerate which email addresses have accounts by
timing the response alone. Doing the work anyway makes both paths cost
roughly the same.

The response body has to match too. The base app's login controller
returns one message for both cases:

```ts
// One message for both "no such account" and "wrong password" — the
// pairing to Auth.attempt()'s constant-time behaviour. Distinguishing
// them here would leak account existence through the response body,
// undoing the timing work entirely.
throw HttpError.unauthorized("Invalid credentials.");
```

And so does validation. The base app's `LoginRequest` deliberately has no
`.min(8)` on the password, unlike registration, rejecting a short
password at validation time tells an attacker their guess was too short
to be this account's password. Login validates *shape* only; correctness
is decided uniformly by `attempt()`.

### Rehash on login

Login is the one moment the framework legitimately holds the plaintext,
so it's the only place a stored hash can be transparently upgraded:

```ts
if (Hash.needsRehash(user.password)) {
  await User.update(user.id, { password: await Hash.make(body.password) });
}
```

See [Encryption & hashing](../encryption/#needsrehash-and-rehash-on-login).

## `TokenGuard`

Opaque, database-backed bearer tokens, modeled on Sanctum's API-token
half. Tokens are revocable server-side, which is the decisive advantage
over JWT for a single-database application: a JWT can't be revoked
without a revocation list, which reintroduces the very database lookup
JWTs exist to avoid.

```ts
export interface TokenGuardConfig {
  provider?: string;
  expiresInMinutes?: number | null;   // null = never expires (default)
}
```

### Token format

```
<uuid-id>|<base64url-secret>
9c7b531f-3ac1-4d51-9d6a-6b0c0a2b5f77|lu8aN1IBZLiVzEi27XDpn_Pks9JYebFTWEWGOWrlMiQ
```

The id is `randomUUID()`; the secret is `randomBytes(32)` encoded
base64url. The plaintext is returned exactly once from `createToken()`
and is never recoverable afterwards, only the digest is stored.

**The id prefix exists for lookup.** The stored column is a digest, so it
can't be looked up by equality. Without an id, verifying a token would
mean loading every token row and comparing each, O(n) work per request,
trivially DoS-able. The id turns it into one indexed primary-key lookup
plus exactly one digest comparison.

`splitToken(plaintext)` returns `[id, secret]` or `null`. It splits on
the **first** `|`, and rejects an empty id or empty secret.

### Why SHA-256, not argon2

`hashToken()` is `createHash("sha256").update(secret).digest("hex")`.
This is deliberate and is not a performance shortcut taken at the cost of
security.

argon2 is intentionally slow to make brute-forcing **human-chosen
passwords** infeasible, passwords occupy a tiny, heavily biased corner
of the keyspace, so the only defense is making each guess expensive. A
personal access token is 32 bytes of `randomBytes`: there is no
low-entropy space to brute-force. The slowness buys nothing while costing
an argon2 verification on **every authenticated API request**. Sanctum
makes the same call for the same reason.

It's fixed rather than configurable: the only alternative setting is
strictly slower for zero security gain, and changing the algorithm would
invalidate every already-issued token, so a config knob would be a trap
rather than a feature.

`verifyTokenHash(secret, storedDigest)` compares with `timingSafeEqual`,
not `===`. Same class of bug `Signer.verify()` guards against, and just
as easy to "simplify" back into a vulnerability during review.

### The `user()` ordering

```ts
const record = await PersonalAccessToken.find(id);
if (record === undefined) return null;

// Verify the secret BEFORE checking expiry so a valid-but-expired
// token and a bogus one take the same path; and reject before
// touching last_used_at so a failed guess never writes.
if (!verifyTokenHash(secret, record.token)) return null;
if (this.isExpired(record)) return null;

await PersonalAccessToken.update(id, { last_used_at: DateTime.now("UTC").toISOString() });

return this.users.retrieveById(record.user_id);
```

Three security-critical orderings in five lines:

1. **Digest before expiry.** If expiry were checked first, an attacker
   holding a known-expired token id could distinguish "this id exists but
   expired" from "this id doesn't exist" by response timing or by which
   branch runs. Verifying the digest first means a bogus secret and a
   valid-but-expired token take the same path out.
2. **`last_used_at` only after a successful verify.** A failed guess must
   never write to the database, otherwise brute-force attempts show up
   as touched rows, and every wrong guess costs a write.
3. **User lookup last.** No user is loaded for a request that failed
   verification.

### API

| Method | Signature | Notes |
|---|---|---|
| `user(request)` | `Promise<TUser \| null>` | The `Guard` contract. Reads `Authorization: Bearer`. |
| `createToken(userId, name)` | `Promise<NewAccessToken>` | Returns `{ token, record }`. `token` is the plaintext, shown once. |
| `revokeToken(id)` | `Promise<void>` | Delete one token by id. |
| `revokeAllTokens(userId)` | `Promise<void>` | "Log out everywhere." |
| `currentTokenId(request)` | `string \| null` | The id half of this request's token, without verifying it. |

The credential itself comes from `Request.bearerToken()`, which parses
`Authorization: Bearer <token>`. A malformed header yields `undefined`
rather than throwing. An unparseable header is an unauthenticated
request, not a server error.

### Issuing and revoking

```ts
// POST /auth/login
const guard = Auth.guard("token") as TokenGuard<UserTable>;
const { token } = await guard.createToken(user.id, "login");

return HttpResponse.json({ user: new UserResource(user).toJson(), token });
```

```ts
// POST /auth/logout — revokes only the token that made this request, so
// logging out on a phone doesn't sign you out on a laptop.
const guard = Auth.guard("token") as TokenGuard<UserTable>;

const tokenId = guard.currentTokenId(request);
if (tokenId !== null) {
  await guard.revokeToken(tokenId);
}
```

`currentTokenId()` deliberately doesn't verify the secret, the request
already passed `authenticate()`, so the token is known good by the time a
controller reads its id.

## `SessionGuard`

The cookie carries a **signed session id and nothing else**; the session
itself lives server-side in a `SessionStore`.

Signing (via [`Signer`](../encryption/#signer), which already supports key
rotation) means a forged or edited cookie is rejected before it ever
reaches the store, so an attacker can't enumerate session ids by
tampering. And because only the id travels, deleting the stored row
revokes the session immediately.

```ts
export interface SessionGuardConfig {
  provider?: string;
  store?: string;               // "database" (default) | "cache" | "array"
  cookie?: string;              // default "session"
  lifetimeMinutes?: number;     // default 120
  rememberMinutes?: number;     // default 400 * 24 * 60 (~400 days)
  sameSite?: "Strict" | "Lax" | "None";
  secure?: boolean;
  domain?: string;
  path?: string;
  prefix?: "secure" | "host";
  slidingCookie?: boolean;   // default true
  name?: string;             // set by the provider; reported by Auth.currentGuard()
}
```

### The cookie

| Attribute | Value |
|---|---|
| Name | `config.cookie ?? "session"`, plus `__Host-`/`__Secure-` if `prefix` is set |
| Value | `signer.sign(sessionId)`: `<uuid>.<hmac>` |
| `HttpOnly` | **hardcoded `true`**, not configurable, limits XSS session theft |
| `Secure` | `config.secure ?? true`: defaults to **on** |
| `SameSite` | `config.sameSite ?? "Lax"` |
| `Path` | `config.path ?? "/"` |
| `Max-Age` | `minutes * 60`, where minutes is the lifetime or remember window |
| `Domain` | only set if `config.domain` is provided |

Setting `prefix: "host"` yields a `__Host-session` cookie, which the
browser refuses to let a sibling subdomain set or overwrite, the
strongest available defense against session fixation from a compromised
`other.example.com`. It requires `secure: true`, `path: "/"` and no
`domain`, so it is opt-in: those constraints break plain-HTTP local
development.

### The cookie is queued, not set through Hono

`login()`, `logout()` and the sliding re-issue all call
`request.queueCookie(...)`; the HTTP boundary writes the queued cookies
onto whatever response the handler returns.

This is a correctness requirement. Mahi handlers return **platform
`Response` objects**, and Hono only merges its context-queued headers
(`c.header()`, and therefore `hono/cookie`'s `setCookie()`) into a
response *it* built via `c.json()`/`c.body()`/`c.newResponse()`. Setting
the cookie through Hono therefore wrote a session row the browser never
learned the id of: login appeared to succeed, and every subsequent
request was anonymous.

The same mechanism is available to application code, see
[`Request` cookies](../requests/#cookies), and is what `csrf()` uses too.

`secure` defaulting to `true` means the cookie will not be sent over
plain HTTP unless you explicitly opt out. The base app sets
`secure: env.NODE_ENV === "production"` so local development over HTTP
works; in production it's on.

`sameSite: "Lax"` is right for same-origin deployments. A cross-origin
SPA needs `"None"`, which browsers only honour alongside `secure: true`,
meaning cookie sessions do **not** work over plain HTTP across origins in
local development. Use the token guard for cross-origin clients.

### Sliding expiry

On every successful `user()` call, the session's expiry is renewed to
**the later** of the normal sliding window and the session's own current
expiry:

```ts
const slid = this.expiresAt(this.lifetimeMinutes);
const renewed = new Date(session.expiresAt).getTime() > new Date(slid).getTime()
  ? session.expiresAt
  : slid;
await this.sessions.touch(sessionId, renewed);
```

Taking the later of the two is what stops a "remember me" session, whose
expiry is already far in the future, from being shrunk back to the short
lifetime on the next request. An ordinary session still slides forward
normally: active sessions keep renewing, abandoned ones lapse.

**The cookie slides with it.** When the renewal actually moves the expiry
forward, the guard re-issues the cookie with a fresh `Max-Age`. Without
that, only the server side slid: the browser still deleted its cookie
`lifetimeMinutes` after *login*, so an actively-used session died
mid-use, precisely what sliding expiry exists to prevent.

A remembered session's cookie is *not* re-sent on every request (its
expiry is already far in the future, so there is nothing to refresh and
it would be pure header weight). Set `slidingCookie: false` for an
absolute lifetime that no amount of activity extends.

### `login()` and session fixation

```ts
const sessionId = await guard.login(request, user.id);
const sessionId = await guard.login(request, user.id, { remember: true });
```

`login()` **always mints a fresh session id, and destroys any
pre-existing session first.** That is the defense against session
fixation, an attacker who plants a known session id in a victim's
browser before login must not still know it afterwards. It's the one
session-specific attack a naive implementation reliably gets wrong; the
behaviour is covered by a dedicated test. Don't "optimise" it into
reusing an existing id.

### Remember me

`{ remember: true }` is deliberately **not** Laravel's recaller-cookie
mechanism. Laravel keeps a *second*, long-lived credential (an
`id|token|hmac` cookie plus a `remember_token` column) specifically to
avoid holding a session row alive for months. A concern that doesn't
apply here, because these sessions are already fully server-side and
revocable by deleting the row.

So "remember me" here simply means **one long-lived session**: `expiresAt`
and the cookie's `Max-Age` use `rememberMinutes` instead of
`lifetimeMinutes`. One optional param, one branch. **No separate recaller
cookie, no extra table, no password-HMAC binding.**

`rememberMinutes` defaults to ~400 days, matching browsers' modern cap on
cookie `Max-Age`.

### API

| Method | Signature | Notes |
|---|---|---|
| `user(request)` | `Promise<TUser \| null>` | Reads and verifies the cookie, slides expiry (and re-issues the cookie). |
| `login(request, userId, { remember? })` | `Promise<string>` | Fresh id, destroys any prior session, queues the cookie, **populates the ambient auth scope**. Returns the id. |
| `logout(request)` | `Promise<void>` | Destroys this session, queues the cookie's deletion, clears the ambient scope. |
| `logoutEverywhere(userId)` | `Promise<void>` | Destroys **every** session for the user, including this one. Database/array store only. |
| `logoutOtherDevices(request, password)` | `Promise<boolean>` | Revokes every *other* session, keeps this one. Re-validates the password first. |
| `gc()` | `Promise<number>` | Deletes expired sessions. Driven by `auth:gc`. |

`login()` writes the user into the ambient auth scope, so `Auth.user()`
works for the **rest of the same request** rather than only from the next
one. Before that, a controller that logged a user in and then tried to
render them hit `UnauthenticatedError` in the handler that had just
authenticated someone.

`logoutOtherDevices()` re-validates the password before mass-revoking,
the standard guard on a security-settings page: confirm it's really the
account owner. It returns `false` without touching anything if the
password doesn't check out, if there's no current session, or if the user
row is gone. It needs a store that can be queried by user.

## Session stores

```ts
export interface SessionStore {
  read(id: string): Promise<SessionRecord | null>;
  write(id: string, userId: string, expiresAt: string): Promise<void>;
  touch(id: string, expiresAt: string): Promise<void>;
  destroy(id: string): Promise<void>;
  destroyForUser(userId: string): Promise<void>;
  destroyForUserExcept(userId: string, exceptId: string): Promise<void>;
  gc(): Promise<number>;
}
```

`SessionRecord` is `{ id, userId, expiresAt }`. That's all a session
holds. There is no arbitrary session-data bag.

| Store | `store:` value | Survives restart | Multi-process | `destroyForUser` |
|---|---|---|---|---|
| `DatabaseSessionStore` | `"database"` (default) | Yes | Yes | Yes |
| `CacheSessionStore` | `"cache"` | Depends on cache driver | Depends on cache driver | **Throws** |
| `ArraySessionStore` | `"array"` | No | No | Yes |

### There is no session data bag

Laravel has `session()->put("key", value)`, `flash()`, `old()` and a
`payload` column holding a serialized blob. Mahi has none of that, and
it is a deliberate omission rather than an unbuilt feature.

The two things a session bag is overwhelmingly used for are **flash
messages** and **old input on validation failure**. Both exist to
survive a `POST` → `302` → `GET` back into a server-rendered form, and
Mahi renders no forms. `HttpResponse` offers `json()`, `file()`,
`redirect()` and `make()`; there is no `view()`. `RedirectResponse` has
no `withErrors()` or `withInput()`. A `ValidationException` always
renders as `422` JSON with a per-field `errors` object, never as a
redirect carrying an error bag. So the machinery would have no consumer.

What a bag *would* cost is concrete. A session blob is read, decoded,
re-encoded and written on **every request that has a session**, whether
or not the request touched it. And because the unit of write is the
whole blob, two concurrent requests lose each other's changes:

```
A reads  { cart: ["apple"] }          B reads  { cart: ["apple"] }
A writes { cart: ["apple", "banana"] }
B writes { cart: ["apple"], wishlist: ["cherry"] }   // banana is gone
```

`B` never touched `cart`. Laravel's answer is `->block()`, a pessimistic
per-session mutex that serializes all concurrent requests for that
session — which turns a page issuing six parallel `fetch` calls into a
queue. Mahi declines to inherit the problem.

### Where cross-request state goes instead

Features that genuinely need state spanning requests get a **typed,
indexed, revocable table** of their own, the same ownership model
`sessions` and `personal_access_tokens` already follow:

| Need | Where it lives |
|---|---|
| Step-up verification | `mfa_intents`, bound to a session or token id |
| The impersonation chain | `impersonations`, `UNIQUE(session_id)` |
| Password resets | `password_reset_tokens`, keyed by email |

Each of those wants something a blob cannot give: an incrementable
`attempts` column, a composite index on the hot read path, a uniqueness
constraint, deletion as revocation. None of them would be better served
by a key in a bag.

For short-lived, single-use, pre-authentication values — the OAuth
`state` and PKCE `code_verifier` that
[`@mahiframework/socialite`](../socialite/) stashes between the redirect
and the callback — the answer is a **signed cookie**, which is exactly
what [`csrf()`](#csrfoptions) already does. It needs no table, no
migration and no garbage collection, and a tamper-evident opaque string
compared against a query parameter needs no server-side storage to be
secure.

### What this rules out, honestly

Three things are genuinely harder here than in Laravel:

- **A guest session.** `write()` takes a non-nullable `userId` and
  `login()` is its only caller, so a session cannot exist before
  authentication. Anything needing per-browser state for an anonymous
  visitor uses a signed cookie or its own table.
- **A synchronizer-token CSRF.** `csrf()` is signed double-submit, not
  session-bound. See [`csrf(options?)`](#csrfoptions) for what that
  costs and why the `__Host-` prefix default closes most of it.
- **A multi-step wizard or a guest cart**, if you wanted it in the
  session rather than in a draft row. A draft row is resumable,
  inspectable and works across devices, so this is usually the better
  shape anyway — but it is more work than `session()->put()`.

This is also the prevailing direction elsewhere: Hono, which Mahi's HTTP
layer is built on, ships no session helper at all; Remix requires an
explicit `commitSession()`; SvelteKit removed its `session` entirely.
If Mahi ever grows a view layer, flash and old input become load-bearing
and a typed bag earns its place — and that is the point at which to
build one.

### All three enforce expiry on read

Every store checks `expiresAt` in `read()` and returns `null` for a stale
record, rather than trusting that `gc()` has run:

```ts
// Expiry is enforced on read rather than relying on gc() having run —
// gc() is a cleanup job, not a correctness guarantee. Treating a
// stale row as valid because the cron hasn't fired would be a real
// vulnerability.
if (new Date(row.expires_at).getTime() <= Date.now()) return null;
```

`CacheSessionStore` does it too, even though the cache TTL should already
have evicted the entry. It keeps all three stores behaviourally
identical.

### `DatabaseSessionStore`

The default. Sessions in a `sessions` table: survives process restarts,
works across multiple processes, and is **queryable**, so "log this user
out everywhere" is one statement. It has no automatic expiry mechanism,
so `gc()` must be run periodically. See [`auth:gc`](#authgc).

### `CacheSessionStore`

Sessions in the cache, with TTL-based expiry handled by the store. Faster than the
database store, with two caveats:

- With the `array` cache driver, sessions vanish on restart.
- `destroyForUser()` and `destroyForUserExcept()` **throw**:

```
CacheSessionStore cannot revoke sessions by user — a cache can't be
queried by value. Use the 'database' session store if you need to log a
user out everywhere.
```

This is not an implementation gap. A cache is a key–value map: you can
ask "what is at key `session:abc`", but there is no way to ask "which
keys hold a value whose `userId` is `x`" without scanning the entire
keyspace, which most cache drivers don't expose at all, and which is a
production hazard on the ones that do (Redis `KEYS`). The alternative
would be maintaining a parallel `user:<id> → [session ids]` index, which
is a second source of truth that can drift out of sync with the sessions
themselves. Throwing loudly is better than silently revoking nothing on a
"sign out everywhere" button.

The store is resolved through `CACHE_TOKEN` at runtime rather than by
importing `@mahiframework/cache`, so `@mahiframework/auth` doesn't take a package
dependency for one optional store. It only needs `get`/`put`/`forget`.

### `ArraySessionStore`

In-memory sessions in a plain `Map`. Zero setup, no I/O, for tests, where
a `SessionGuard` can be exercised end to end without a database round-trip
or a cache backend. Not for production.

Unlike `CacheSessionStore`, this one **can** back `destroyForUser()`: it
holds the records directly, so it can scan them by value.

## `DatabaseUserProvider`

Retrieves users from any model class, verifying passwords with the
app's `Hasher` (argon2).

```ts
export interface DatabaseUserProviderConfig {
  model: AnyModelClass;
  identifierColumn?: string;   // default "email"
  passwordColumn?: string;     // default "password"
}
```

`AnyModelClass` is the value-side "any model class" type, `typeof Model`
now names the `Model()` factory function rather than a class, so a config
that accepts a model class spells it this way.

### Global scopes apply

Lookups go through `Model.query()`, **not** `queryWithoutScopes()`:

```ts
async retrieveByCredentials(credentials: Credentials): Promise<TUser | null> {
  const value = credentials[this.identifierColumn];
  if (value === undefined || value === "") return null;

  const row = await this.config.model.query().where(this.identifierColumn, value).first();
  return (row as TUser | undefined) ?? null;
}
```

That single decision means **a soft-deleting user model stops
authenticating deleted users with no extra code on either side**. The
soft-delete global scope adds `WHERE deleted_at IS NULL` to every
`query()`, so a soft-deleted user simply isn't found, by the login
lookup, and by `retrieveById()` on every subsequent authenticated
request, so existing tokens and sessions stop working too.

The base app's `User` model is configured with `softDeletes: true`, so
this is the default behaviour out of the box.
Any global scope you add to the user model participates: a `tenant` scope,
an `active` scope, a `banned_at IS NULL` scope. See
[Models](../models/#global-scopes) and
[Queries](../queries/).

`updatePassword()` writes back keyed by the model's `primaryKey`. It's
what `PasswordBroker.reset()` calls.

### The `users` table is app-owned

`@mahiframework/auth` ships no `users` migration and no `User` model. Every real
app wants its own columns there (tenant, avatar, role), and a
framework-owned users table would mean either a publish-and-edit step or
apps fighting the framework's schema forever. The package only ships the
tables internal to its own guards.

## Passwords

`PasswordBroker` handles the reset flow. One broker over one
`UserProvider`, deliberately narrower than Laravel's multi-broker
`PasswordBrokerManager`, since this framework has no multi-user-table
goal. Resolve it with `Auth.passwordBroker()`; it's cached after first
resolution.

```ts
export interface PasswordBrokerConfig {
  expiresInMinutes?: number;   // default 60
}
```

Configured under `auth.passwords`, with an optional `provider` key to
point it at a user provider other than the default guard's.

### `sendResetLink(email)`

```ts
type SendResetLinkResult =
  | { status: "sent"; email: string; token?: string }
  | { status: "throttled" };
```

| Status | When | `token` present |
|---|---|---|
| `"sent"` | A user matched. A token was minted and a row written | Yes |
| `"sent"` | **No user matched**: nothing minted, nothing written | **No** |
| `"throttled"` | Only ever returned when a real user was found | No |

**The no-enumeration behavior is the point.** When no user matches, the
broker returns `{ status: "sent", email }` with **no token** and **writes
no row**. That's the same shape as success, so a caller that relays the
status directly to the client can't be used to enumerate which email
addresses have accounts.

Note what this means for the caller: you must branch on `token`, not on
`status`, to decide whether to actually send mail:

```ts
const result = await Auth.passwordBroker().sendResetLink(body.email);

if (result.status === "sent" && result.token !== undefined) {
  const url = URL.signedRoute("password.reset", { token: result.token, email: result.email });
  await Mail.send(new ResetPasswordMail(url).to(result.email));
}

// Same response either way.
return HttpResponse.json({ status: "sent" });
```

On success the raw token is handed back to the **caller**, which decides
how to deliver it (email, SMS). The framework owns the mechanism, the app
owns the UX.

One live reset per email: `sendResetLink()` **upserts**, rather than
accumulating rows. `email` is the primary key. (It used to
delete-then-insert, which two concurrent requests, a double-clicked
form, could interleave into a primary-key violation and a 500.)

#### `"throttled"`

`throttled` is returned when a token was minted for this address less
than `throttleSeconds` ago (default 60, Laravel's value; set `0` to
disable). It is only ever reachable for a **real** account, an unknown
address returns `"sent"` above without ever consulting the table, so it
leaks nothing an attacker couldn't already determine.

This is deliberately *in addition to* the `throttle()` HTTP middleware on
the route, because the two answer different questions: middleware limits
how often one **client** may ask, this limits how often one **mailbox**
may be written to. An attacker rotating IPs to flood a victim's inbox
defeats the first and not the second.

### `reset(email, token, newPassword)`

```ts
type ResetResult =
  | { status: "reset" }
  | { status: "invalid-token" }
  | { status: "expired-token" }
  | { status: "invalid-user" };
```

| Status | Meaning | Side effect |
|---|---|---|
| `"reset"` | Password updated | Token row deleted (single use); **all sessions and access tokens revoked**; listeners fired |
| `"invalid-token"` | No row for this email, or the token doesn't match the stored hash | Row left in place |
| `"expired-token"` | Row found but older than `expiresInMinutes` | **Stale row deleted** |
| `"invalid-user"` | Token verified but the user no longer exists | Row left in place |

The order matters: expiry is checked **before** the hash comparison, so an
expired row is swept even if the presented token is wrong.

The no-row path still performs a hash before returning `invalid-token`.
Otherwise "no pending reset" would return instantly while "wrong token"
paid for an argon2 verify (~50–100 ms at 64 MiB), a timing oracle for
which accounts have a reset pending, and an unthrottled way to make the
server burn CPU. `attempt()` does the same on its miss path.

### A successful reset revokes everything else

Password reset is the account-**recovery** path: the thing a user does
*because* they believe they were compromised. So on success the broker
destroys every session and revokes every personal access token for that
user.

Without it, the attacker's existing session simply survived the recovery
that was meant to end it, and these sessions are server-side and
long-lived, with a "remember me" session running to ~400 days.

`AuthManager` wires the revokers automatically from the configured
guards. Revocation is best-effort per store: `CacheSessionStore` cannot
revoke by user at all (it throws by design), and that must not turn a
successful reset into a 500. The password has already changed by then.

To react to a reset (notify the user, write an audit record):

```ts
Auth.passwordBroker().onPasswordReset(({ user, email }) => {
  // ...
});
```

### Reset tokens are argon2-hashed

Unlike personal access tokens (SHA-256), reset tokens go through the
shared `Hasher`:

```ts
const token = randomBytes(32).toString("base64url");
const hashed = await this.hasher.make(token);
```

A reset token is a short-lived credential a human may paste around, and
hashing it means a leaked `password_reset_tokens` dump yields nothing
usable. Verification is a single PK lookup by email plus one
`Hasher.check()`, once per reset, not once per request, so argon2's cost
is irrelevant here in a way it isn't for API tokens.

### Rate limiting: use both layers

The broker throttles per **email** (see
[`"throttled"`](#throttled) above). Add the `throttle()` HTTP middleware
per **client** on the route as well. They cover different attacks:

```ts
auth.post("/password/forgot", ForgotPasswordController)
  .middleware(throttle("password-reset"));
```

See [Cache](../cache/) and
[Routing](../routing/#middleware).

Constant-time response is the caller's job too, the "no such account"
path returns much faster than "account exists, hash a token, write a row,
send mail". Wrap the call in
[`timebox()`](../encryption/#timebox):

```ts
import { timebox } from "@mahiframework/encryption";

const result = await timebox(() => broker.sendResetLink(body.email), 250);
```

### `gc()`

Deletes reset tokens older than `expiresInMinutes` and returns how many.
Driven by [`auth:gc`](#authgc).

## Email verification

Plain composable functions, **not** a trait or mixin, `Model` rows are
plain objects, so there's no class to mix into. There is deliberately no
`MustVerifyEmail` interface to implement and no base class: opting a model
in is just adding the nullable `email_verified_at` column in its
migration.

| Function | Signature | Notes |
|---|---|---|
| `hasVerifiedEmail(user, column?)` | `boolean` | `column` defaults to `"email_verified_at"`. `undefined` counts as unverified. |
| `markEmailAsVerified(model, userId, column?)` | `Promise<string>` | Stamps `now` via `model.update()`, returns the timestamp written. |

`markEmailAsVerified()` is idempotent at the storage layer, calling it
twice rewrites the timestamp. Callers that must not "re-verify" should
guard with `hasVerifiedEmail()` first.

### `EmailVerificationBroker`

The two helpers above are the state mechanics. `EmailVerificationBroker`
is the flow around them, the counterpart to `PasswordBroker`, resolved
the same way:

```ts
const broker = Auth.verificationBroker();
```

| Method | Returns | Notes |
|---|---|---|
| `sendVerificationLink(userId, signerOptions?)` | `{ status: "sent"; url }` \| `already-verified` \| `invalid-user` | Mints the signed link for the caller to deliver. |
| `verify(userId, hash)` | `verified` \| `already-verified` \| `invalid-user` \| `invalid-hash` | Checks the hash, then stamps the column. |
| `verificationUrl(userId, email, signerOptions?)` | `string` | The URL on its own, if you have the address already. |
| `hasVerified(user)` | `boolean` | `hasVerifiedEmail()` against the configured column. |

Configure it in `config/auth.ts`:

```ts
verification: {
  model: User,                   // required — see below
  expiresInMinutes: 60,
  path: "/auth/verify-email",    // must match the registered route
},
```

`model` is required and `passwords` has no equivalent, because the two
brokers write differently: `PasswordBroker` delegates to
`UserProvider.updatePassword()`, while this one stamps an arbitrary
column, which `UserProvider` has no method for. Widening that interface
for a single caller wasn't worth it, so the model is configured instead.

### No token table

Unlike password reset, this stores nothing. The link is an HMAC-signed
URL, so there is no table, no migration and no GC sweep.

That trade is right here and wrong for password reset, because the two
differ decisively. A reset token is a credential that grants the ability
to **change a password**, so it must be revocable, single-use, and hashed
at rest. A verification link only ever asserts "whoever received mail at
this address asked for this", grants no capability beyond flipping one
boolean, and is naturally idempotent, clicking twice is a no-op.

The cost, stated plainly: a verification link **cannot be revoked** before
it expires, and re-sending mints a second link without invalidating the
first. If your app needs revocation, model it on the reset flow with a
token table instead.

### The email hash

The signed payload carries a hash of the address being verified, and
`verify()` recomputes it against the user's **current** address.

Without it the flow has a real hole: request a link for `a@example.com`,
change the account's address to `victim@example.com` before clicking, then
click, and the account is now "verified" at an address that never
received anything. The signature does not catch this, because the URL was
legitimately signed. Only the hash does.

It's a fast SHA-256, not argon2, and deliberately: this is not a secret.
It's a tamper-evident binding between link and address, the link is
already HMAC-signed, and an attacker can compute the hash of any address
they know regardless. Making it slow would only make every click slow.

### The full flow

```ts
// Route — the signature IS the credential, so no authenticate() here.
auth.get("/verify-email", VerifyEmailController)
  .middleware(validateSignature())
  .name("auth.verification.verify");
```

```ts
// Handler — validateSignature() has already rejected tampered and expired
// links, so only the two things a signature cannot prove are left.
const result = await Auth.verificationBroker().verify(
  request.query("id")!,
  request.query("hash")!,
);
```

```ts
// Sending — the broker returns the URL; delivery is yours.
const result = await Auth.verificationBroker().sendVerificationLink(user.id);

if (result.status === "sent") {
  await Mail.send(new VerifyEmailMail(user.email, result.url, 60));
}
```

Then gate the routes that require it:

```ts
posts.post("/", CreatePostController)
  .middleware(authenticate(), ensureEmailVerified());
```

### No throttle here, unlike password reset

`PasswordBroker` has `throttleSeconds`; this has nothing equivalent, and
that asymmetry is intentional. "Forgot password" is **unauthenticated**,
so anyone can point it at a stranger's mailbox. The per-mailbox throttle
is the only thing that stops an inbox flood, because an attacker rotating
IPs defeats the middleware. A resend endpoint is authenticated and can
only ever mail the caller's own address, so ordinary `throttle()`
middleware on the route is the correct and sufficient control.

## What the framework sends, and what your app sends

`@mahiframework/auth` **sends no email** and does not depend on `@mahiframework/mail`. Both
brokers hand back a token or URL and stop there:

```ts
const { token } = await Auth.passwordBroker().sendResetLink(email);
const { url }   = await Auth.verificationBroker().sendVerificationLink(id);
```

The mailables and the controllers that send them are **scaffolded into
your app** (`src/mail/`, `src/http/controllers/`), where you can edit the
copy, swap the theme, or delete them. This is the same split as
`register`/`login`/`logout`: the framework owns the mechanism, the app
owns the UX.

To keep the scaffolded flow but take delivery over yourself, an event
listener, SMS, an ESP's API, turn the send off:

```bash
AUTH_SEND_RESET_EMAIL=false
AUTH_SEND_VERIFY_EMAIL=false
```

```ts
// config/auth.ts — the generated controllers read these; the framework does not.
notifications: {
  resetPassword: env.AUTH_SEND_RESET_EMAIL,
  verifyEmail: env.AUTH_SEND_VERIFY_EMAIL,
},
```

The broker still mints the token or link and the endpoint still responds
normally; only the send stops.

### Auth email sends synchronously: don't queue it

The scaffolded controllers call `Mail.send()`, not a queued job, and that
is a security decision rather than a simplification.

`sendResetLink()` returns the raw token **once**, only its argon2 hash is
stored, so the plaintext is unrecoverable afterwards. Queueing the send
therefore writes a live credential into the `jobs` table, and into
`failed_jobs` indefinitely if the send fails. Keeping the send inline
keeps the token in memory only.

The two failure paths are handled differently, and the difference is what
a retry costs:

- **Forgot password** deletes the token row and rethrows. The row is
  written before the email goes out, so a failed send would otherwise
  leave a token the user never received *and* start the per-mailbox
  throttle, locking them out for a minute over our failure.
- **Registration** logs and swallows. The account already exists by then,
  so a 500 would tell the user to retry, and the retry would fail
  `unique(email)` validation and strand them. The resend endpoint is the
  recovery path.

## Tables

`@mahiframework/auth` contributes three migrations via its `migrations()` hook.
None of them has a foreign key to `users`. That table is app-owned and
the framework can't assume its name.

### `personal_access_tokens`

```ts
table.string("id").primary();
table.string("user_id").index();
table.string("name");
table.string("token");
table.timestamp("last_used_at").nullable();
table.timestamp("expires_at").nullable();
table.timestamp("created_at");
```

`token` stores a SHA-256 digest, never the plaintext secret. The primary
key is the id clients send as the `"<id>|<secret>"` prefix, so
authenticating is one indexed PK lookup. `user_id` is indexed for
`revokeAllTokens()`.

### `sessions`

```ts
table.string("id").primary();
table.string("user_id").index();
table.timestamp("expires_at").index();
table.timestamp("created_at");
table.timestamp("last_active_at");
```

`expires_at` is indexed for `gc()`, `user_id` for "log this user out
everywhere".

### `password_reset_tokens`

```ts
table.string("email").primary();
table.string("token");
table.timestamp("created_at");
```

`email` is the primary key, not a surrogate id: a user has at most one
outstanding reset, so re-requesting overwrites rather than accumulating,
and verification is a single indexed PK read. `token` is an argon2 hash.

### The models

`PersonalAccessToken`, `Session`, and `PasswordResetToken` are exported
and are ordinary models you can query. All three leave `keyType` at its
default and supply the key themselves (the PKs are client-generated
strings), and set `timestamps: false` (no `updated_at` column, `last_used_at` /
`last_active_at` already mean "when did this last change", more precisely
than an auto `updated_at` would).

They're framework-owned rather than app-owned because they're internal
implementation details of the built-in guards, the same ownership
rationale as `@mahiframework/queue` owning `jobs`.

## `auth:gc`

```bash
./artisan auth:gc
```

Deletes expired sessions, expired **personal access tokens**, and expired
password-reset tokens, logging a count for each.

Every one of those stores enforces expiry on read, so a stale row is
never *honoured*, but nothing deletes them either, so the tables grow
unboundedly without this. It's a cleanup job, not a correctness
guarantee.

Guards are swept by **capability**, not by name: any configured guard
exposing `gc()` is collected. That matters because guards are app-named,
an app following Laravel's `web`/`api` convention has no guard called
`"session"` at all, and the previous hardcoded lookup silently swept
nothing while the tables grew.

Tokens with a null `expires_at` never expire (the Sanctum default) and
are left alone.

Schedule it daily:

```ts
schedule(schedule: Schedule): void {
  schedule
    .call(async (app) => {
      await new AuthGcCommand(app).handle();
    })
    .daily()
    .name("auth-gc")
    .withoutOverlapping();
}
```

See [Scheduling](../scheduling/).

## Events

Every security-relevant act dispatches an event. They exist so the
concerns that always accrete around authentication — audit logs, failed
login alerting, "new device" notifications, forced re-verification — can
be written once, in a listener, instead of being bolted onto every
controller that happens to touch auth.

| Event | Dispatched when | Notable fields |
|---|---|---|
| `Attempted` | credentials verified, either outcome | `credentials`, `succeeded`, `user`, `guard` |
| `Failed` | credentials rejected | `credentials`, `guard` |
| `Authenticated` | a request resolved a user | `userId`, `user`, `guard`, `viaActingAs` |
| `Login` | a session was established | `userId`, `user`, `sessionId`, `remember`, `guard` |
| `Logout` | a session was destroyed | `userId?`, `user?`, `sessionId?`, `guard` |
| `OtherDeviceLogout` | "sign out everywhere else" succeeded | `userId`, `keptSessionId` |
| `CurrentDeviceLogout` | every session destroyed, including this one | `userId`, `reason` |
| `TokenCreated` | a personal access token was issued | `userId`, `tokenId`, `name` |
| `TokenRevoked` | one or all tokens revoked | `tokenId?`, `userId?`, `all`, `reason` |
| `PasswordResetLinkSent` | a reset token was minted | `email`, `user` |
| `PasswordReset` | a password was reset via token | `email`, `user` |
| `EmailVerificationSent` | a verification link was minted | `userId`, `email` |
| `EmailVerified` | an address became verified | `userId`, `email` |
| `CsrfTokenMismatch` | `csrf()` rejected a request | `method`, `path` |

Register listeners the usual way, from a provider:

```ts
listeners(): ReadonlyArray<ListenerRegistration> {
  return [
    [Failed, ThrottleRepeatedFailures],
    [Login, NotifyOnNewDevice],
    [PasswordReset, RecordSecurityActivity],
  ];
}
```

### `Login` also fires when impersonation starts and stops

`@mahiframework/impersonation` establishes a real session through
`Auth.login()` in both directions, so `start()` dispatches a `Login` for
the impersonated user and `stop()` dispatches one for the admin returning
to their own account. That is accurate — a session genuinely was
established — but an audit log reading `Login` alone would record an
impersonation as an ordinary sign-in.

Pair it with the impersonation events, which fire alongside and carry both
parties:

```ts
listeners(): ReadonlyArray<ListenerRegistration> {
  return [
    [Login, RecordSignIn],
    [ImpersonationStarted, RecordImpersonation],
  ];
}
```

Or resolve the impersonator inside the `Login` listener with
`Impersonation.rootImpersonator(request)`. See
[Impersonation](../impersonation/).

### Observing all of them at once

Every event extends `AuthEvent`, and listeners match with `instanceof`,
so one registration covers the subsystem:

```ts
events.listen(AuthEvent, RecordSecurityActivity);
```

Prefer this to enumerating the table above. An explicit list silently
misses whichever event is added next, which for a security log is the
failure mode that matters. The name-pattern form works too, and is what a
package that cannot import `@mahiframework/auth` should use:

```ts
events.listen("auth.*", RecordSecurityActivity);
```

### A throwing listener fails the operation

Auth events are dispatched **in-band and awaited**, and errors are **not**
caught. A listener that throws fails the login, logout or reset that
dispatched it.

This is deliberate, and it is the opposite of
[queue job events](../queues/), which swallow listener errors so a
crashing observer cannot fail a job. The reasoning is that a queue worker
which loses an observer has lost telemetry, whereas an audit listener that
cannot write has lost the record of a security-relevant act — and under a
regime where that record is mandatory, proceeding as if nothing happened
is the worse outcome. It also means a listener can refuse an action by
throwing, which is how a lockout policy written in application code can
actually stop a login.

The cost is equally real: **an unhandled error in any auth listener is an
authentication outage.** A listener doing anything failure-prone (an
outbound HTTP call, a third-party SDK) must catch its own errors:

```ts
export class NotifyOnNewDevice implements Listener<Login> {
  constructor(private app: Application) {}

  async handle(event: Login): Promise<void> {
    try {
      await this.pager.notify(event.userId);
    } catch (error) {
      // Never let telemetry break a login.
      this.app.logger.error("new-device notification failed", { error });
    }
  }
}
```

### Credentials and tokens are never on an event

`Attempted` and `Failed` carry `credentials` with the secret stripped
(`password`, `password_confirmation`, `secret`, `token`), so the
identifying column survives for "47 attempts against this address" and the
password does not.

For the same reason `TokenCreated` carries the token **id** and not the
plaintext, `PasswordResetLinkSent` omits the reset token, and
`EmailVerificationSent` omits the signed URL. Each of those is a
credential or a capability, and an event spreads its payload to every
listener, audit row and queued job in the application.

### What is deliberately not dispatched

- **No `-ing` events.** There is no `Authenticating` or `LoggingOut`. They
  would be a second, weaker authorization layer beside the one the
  framework already has, and "deny by throwing from a listener" yields an
  error no route can turn into a sensible response. Decide in a guard, a
  middleware or a gate.
- **`Attempted`/`Failed` cannot tell "no such account" from "wrong
  password."** `attempt()` deliberately does not know, and an event that
  leaked the difference would re-create the account-enumeration oracle its
  constant-work hash exists to remove.
- **`PasswordResetLinkSent` does not fire for an unknown address**, for
  the same reason: `sendResetLink()` returns `{ status: "sent" }` either
  way, and an event firing only for real accounts would record at the
  event layer exactly what the response shape conceals. To detect an
  enumeration sweep, count requests with `throttle()` middleware instead.
- **`EmailVerified` fires only on the transition**, not on a repeat click,
  so a one-time "welcome" action does not run on every page refresh.
- **Nothing fires on a failed reset or a stale verification hash.** Those
  are indistinguishable from probes.
- **No auth event marks impersonation.** `viaActingAs` on `Authenticated`
  reports only that the user came from an `actingAs()` override rather
  than a credential check, which is how `TestClient.actingAs()`
  authenticates. It does not identify an impersonator, because
  `actingAs()` is a process-wide override with no marker in the auth
  state. Real impersonation is
  [`@mahiframework/impersonation`](../impersonation/), which dispatches
  its own `ImpersonationStarted`/`ImpersonationFinished` and exposes
  `Impersonation.rootImpersonator(request)` for exactly the
  "attribute this action to the admin behind it" case.

### Without `EventsServiceProvider`

Dispatch is a no-op when nothing is bound at `EVENTS_TOKEN`, so an
application that never registers `EventsServiceProvider` is unaffected.
`@mahiframework/events` is nevertheless a declared dependency of
`@mahiframework/auth`: it was already an unavoidable transitive one
through `@mahiframework/database`, so naming it adds nothing to the
install graph and buys compile-time types.

### `onPasswordReset()` still works

`PasswordBroker.onPasswordReset()` predates these events, carries the same
`{ user, email }` payload, and is still called — alongside `PasswordReset`
— so nothing using it needs to change. Prefer the event for new code: it
is observable from a provider's `listeners()` hook without a reference to
the broker.

## Testing

Pass `{ fakeEvents: true }` to `createTestApplication()` and assert on
the recording dispatcher:

```ts
testApp.events!.assertDispatched(Failed, (event) => event.credentials.email === email);
testApp.events!.assertNotDispatched(Login);
```

`Auth.runAs()` is the supported way to establish an identity without a
request:

```ts
const user = await User.factory().createOne();

await Auth.runAs(user, async () => {
  expect(Auth.check()).toBe(true);
  expect(await Gate.allows("delete", Post, post)).toBe(true);
});
```

For HTTP-level tests, issue a real token and send it. The guard path is
then exercised end to end:

```ts
const guard = Auth.guard("token") as TokenGuard<UserTable>;
const { token } = await guard.createToken(user.id, "test");

const response = await client.getJson("/auth/me", {
  headers: { Authorization: `Bearer ${token}` },
});
```

For session-guard tests, point `auth.guards.session.store` at `"array"`
so no database round-trip is needed. See [Testing](../testing/).

## Related

- [Events](../events/): dispatching, listeners, the `listeners()` hook
- [Authorization](../authorization/): gates, policies, `can()`, `authorize()`
- [Encryption & hashing](../encryption/): `Hash`, `Signer`, signed URLs
- [Routing](../routing/): where `authenticate()` and `csrf()` are attached
- [Requests](../requests/): form requests and their `authorize()` hook
- [Models](../models/): global scopes, `softDeletes`
- [Service providers](../providers/): the `middleware()`, `migrations()`, and `commands()` hooks
- [Cache](../cache/): the `RateLimiter` behind `throttle()`
- [Scheduling](../scheduling/): running `auth:gc` daily
