# Routing

Routes map an HTTP method and path to a handler. In Mahi a handler is
either a plain function taking a [`Request`](../requests/) or a
[single-action controller class](../controllers/). There is no global
`routes/web.php` equivalent. Routes are registered from a service
provider's `routes()` hook, so a feature's routes live beside the rest of
it.

```ts
import { ServiceProvider } from "@mahiframework/core";
import type { Router } from "@mahiframework/http";

export class PostsServiceProvider extends ServiceProvider {
  routes(router: Router): void {
    router.get("/posts/{post}", GetPostController).name("posts.show");
  }
}
```

## Where routes are registered

`HttpServiceProvider.boot()` calls `HttpKernel.collectFromProviders()`,
which walks every registered provider in `config/app.ts` order and calls
its optional `routes(router)` hook. By the time `bin/server.ts` or
`artisan serve` binds a port, every route is mounted, regardless of which
entrypoint booted the application. That's also why `./artisan route:list`
works from the console without starting a server.

The `routes()` hook is declared by `@mahiframework/http` via TypeScript declaration
merging onto `@mahiframework/core`'s `ProviderHooks` interface, so it's typed on
every `ServiceProvider` subclass once `@mahiframework/http` is imported.

Most applications keep the route definitions in their own module and have
the provider delegate:

```ts
// src/routes/posts.routes.ts
export function registerPostRoutes(router: Router): void {
  router.group("/posts", (posts) => {
    posts.middleware(authenticateOptional());

    posts.get("/", ListPostsController).name("posts.index");
    posts.get("/{post}", GetPostController).name("posts.show");
    posts.post("/", CreatePostController)
      .middleware(authenticate(), throttle("create-post"))
      .name("posts.store");
    posts.delete("/{post}", DeletePostController)
      .middleware(authenticate())
      .name("posts.destroy");
  });
}

// src/providers/posts.provider.ts
export class PostsServiceProvider extends ServiceProvider {
  routes(router: Router): void {
    registerPostRoutes(router);
  }
}
```

## Path syntax

**Route paths use Laravel-style `{param}` braces. Nothing else.**

| Pattern | Meaning |
|---|---|
| `/posts/{post}` | Required parameter |
| `/files/{path?}` | Optional parameter |
| `/storage/*` | Hono wildcard (passed through untouched) |

The router translates `{param}` into the Hono `:param` form internally
(`translatePath()`), but a raw `:param` in your own path is **rejected**:

```ts
router.get("/posts/:id", handler);
// Error: Route path "/posts/:id" uses ":param" syntax; this framework
// uses "{param}" (e.g. "/posts/{id}").
```

This is deliberate. Mahi sits on Hono, whose native syntax is `:param`, so
both forms would otherwise silently work, and you'd end up with two
syntaxes in one codebase, only one of which the URL generator can
substitute into. `RouteRegistry` stores paths in `{param}` form because
that's the form `URL.route()` needs. Rather than accept both and quietly
break named-route generation for half of them, the router throws at
registration time with the corrected path in the message.

Read parameters back off the request with `route()` or `parameter()`:

```ts
request.route("post");        // string | undefined
request.parameter("post");    // string — throws if the route didn't define it
request.route();              // { post: "42" }
```

See [route-model binding](../requests/#route-model-binding) for turning a
`{post}` segment straight into a model.

## Verbs

Every verb takes `(path, handler)` and returns a `PendingRoute` for
chaining.

| Method | Registers |
|---|---|
| `router.get(path, handler)` | `GET` |
| `router.post(path, handler)` | `POST` |
| `router.put(path, handler)` | `PUT` |
| `router.patch(path, handler)` | `PATCH` |
| `router.delete(path, handler)` | `DELETE` |
| `router.options(path, handler)` | `OPTIONS` |
| `router.head(path, handler)` | `HEAD` |
| `router.query(path, handler)` | `QUERY`: the draft HTTP method: a safe, idempotent, body-carrying `GET` |
| `router.any(path, handler)` | All of the above |
| `router.match(methods, path, handler)` | The methods you list (case-insensitive; uppercased internally) |

`any()` is expanded to the explicit list `GET POST PUT PATCH DELETE OPTIONS
HEAD QUERY` rather than using a Hono "all methods" primitive, because Hono's
`ALL` entries don't report usefully through `hono.routes`, and
`route:list` reads that. The cost is eight registrations instead of one;
the benefit is that `route:list` shows what actually answers.

A handler is either a function or a controller class:

```ts
// Function handler
router.get("/health", () => HttpResponse.json({ ok: true }));

// Controller class — the router detects it via `isControllerClass()`
router.get("/posts/{post}", GetPostController);
```

## Groups

`group(basePath, callback)` mounts a fresh sub-router under a prefix. The
prefix accumulates for named-route paths, and nesting works:

```ts
router.group("/api", (api) => {
  api.group("/v1", (v1) => {
    v1.get("/posts/{post}", GetPostController).name("api.posts.show");
    // Registered path: /api/v1/posts/{post}
  });
});
```

`joinPaths()` collapses duplicate slashes and strips a trailing one, so
`group("/posts")` plus `get("/")` yields `/posts`, not `/posts/`.

## Middleware

Mahi middleware is an `HttpPipe`, a `@mahiframework/pipeline` `Pipe<Request,
ResponseInput>`:

```ts
import type { HttpPipe } from "@mahiframework/http";

const requestId: HttpPipe = async (request, next) => {
  request.share("requestId", crypto.randomUUID());
  const response = await next(request);
  response.headers.set("X-Request-Id", request.shared<string>("requestId")!);
  return response;
};
```

The passable is the framework `Request`, never Hono's `Context`, app and
provider code never imports Hono. A pipe that returns without calling
`next(request)` short-circuits the rest of the stack.

There are four places to attach one.

### Route-level

```ts
router.post("/posts", CreatePostController)
  .middleware(authenticate(), throttle("create-post"));
```

Stored on the `PendingRoute` object and run at request time inside the
route's own pipeline, not registered as extra Hono handlers. That's why
`route:list` shows a middleware-bearing route once rather than once per
pipe.

### Group-level

```ts
router.group("/posts", (posts) => {
  posts.middleware(authenticateOptional());   // must come first — see below
  posts.get("/", ListPostsController);
});
```

`Router.middleware()` mounts onto the group's Hono instance with
`use("*")`.

> **Gotcha:** `middleware()` inside a `group()` only applies to routes
> registered **after** it. Hono matches `use("*")` handlers registered
> before the route, so this silently runs nothing:
>
> ```ts
> router.group("/posts", (posts) => {
>   posts.get("/", ListPostsController);          // no middleware!
>   posts.middleware(authenticateOptional());     // too late
> });
> ```
>
> Always put group middleware at the top of the callback.

### Path-scoped

```ts
router.use("/protected/*", authenticate());
```

Same `use("*")` mechanism, scoped to a pattern. The path goes through
`translatePath()`, so `{param}` syntax works here too.

### Global

Contributed from a provider's `middleware()` hook. See
[the global pipeline](#the-global-middleware-pipeline) below.

## Named routes

```ts
router.get("/posts/{post}", GetPostController).name("posts.show");
```

`name()` registers into the `RouteRegistry` the router was constructed
with. One registry is owned by the `HttpKernel` and threaded into the root
router and every `group()` sub-router, so a `.name()` anywhere lands in the
same table. The **full** path (group prefixes included) is stored, in
`{param}` form.

Names must be unique. A duplicate throws immediately, at registration:

```
Route name "posts.show" is already registered for [GET /posts/{post}];
route names must be unique.
```

Silently overwriting would make `URL.route("posts.show")` return whichever
provider happened to boot last, a bug that only shows up in a generated
link. Failing at boot is louder and cheaper.

## The `Route` facade

Routes can also be registered statically, outside a provider's `routes()`
hook:

```ts
import { Route } from "@mahiframework/http";

Route.get("/health", () => HttpResponse.json({ ok: true })).name("health");
Route.group("/admin", (admin) => admin.get("/", DashboardController));
```

`Route` extends `Facade<Router>(() => ROOT_ROUTER_TOKEN)` and forwards to
the kernel's root `Router`, bound under `ROOT_ROUTER_TOKEN` (`"http.router"`)
by `HttpServiceProvider`. It exposes `get`/`post`/`put`/`patch`/`delete`/
`options`/`head`/`query`/`any`/`match`/`group`/`middleware`/`use`.

The provider hook is still the recommended home for a package's routes:
it's ordered deterministically by the provider list, and it doesn't
require the container to be resolvable at module-evaluation time. Use the
facade for one-off registrations where importing a whole provider is
overkill.

If you need the raw Hono instance for something the router doesn't cover,
`router.raw()` returns it.

## Generating URLs

The `URL` facade proxies the `UrlGenerator` singleton bound at
`URL_GENERATOR_TOKEN`. It reads the same `RouteRegistry` the router writes
to.

| Method | Result |
|---|---|
| `URL.to(path, options?)` | Absolute URL for a bare path. An already-absolute `http(s)://` input passes through unchanged. |
| `URL.route(name, params?, options?)` | URL for a named route |
| `URL.signedRoute(name, params?, options?)` | Tamper-evident, optionally-expiring URL for a named route |
| `URL.has(name)` | Whether a route name is registered |

```ts
URL.route("posts.show", { post: 42 });                        // https://app.test/posts/42
URL.route("posts.show", { post: 42 }, { absolute: false });   // /posts/42
URL.to("/dashboard");                                          // https://app.test/dashboard
```

`urlGenerator()` resolves the same instance as a plain function, if you'd
rather not use the facade.

### Leftover params become query string

Params consumed by a `{segment}` are substituted; anything left over is
appended as a query string:

```ts
URL.route("posts.show", { post: 42, page: 2 }, { absolute: false });
// "/posts/42?page=2"
```

Values are `encodeURIComponent`'d during substitution.

### Missing required params throw

```ts
URL.route("posts.show", {});
// Error: Missing required parameter "post" for route "/posts/{post}".
```

Optional `{param?}` segments may be omitted; the resulting `//` or trailing
`/` is collapsed.

An unknown name throws `RouteNotFoundError`:
`Route [nope] is not defined.`

### How the absolute root is resolved

Absolute URLs need a `scheme://host`. `UrlGenerator.root()` resolves it in
this order:

1. **The in-flight request's root.** Every `Request`, on construction,
   publishes `scheme://host` into the per-request `Context` overlay under
   `REQUEST_ROOT_CONTEXT_KEY`. The generator reads it back. Because the
   overlay is opened per-request by the kernel's outermost pipe (see
   below), concurrent requests never see each other's host.
2. **The `http.url` config value** (`APP_URL` in the generated app), used
   by queue jobs, scheduled tasks, and CLI commands, which have no request.
3. **Throws.**

```
Cannot generate an absolute URL: no active request and no `http.url`
config set. Set `http.url` (APP_URL) or pass `{ absolute: false }`.
```

Falling back to a relative URL here would be worse than failing: an email
containing `/reset-password?token=…` is broken in a way nobody notices
until a user clicks it. The error names both fixes.

## Signed URLs

A signed URL is tamper-evident but not secret: `path?params&expires&signature`,
where the signature is an HMAC over the path plus every query param except
`signature` itself. It uses `@mahiframework/encryption`'s `Signer` (HMAC), not the
`Encrypter`. The payload doesn't need to stay hidden, only to be
unforgeable, and `Signer.verify()` handles key rotation. This is the
machinery behind email verification, password reset, and one-click
unsubscribe links.

Two entry points, sharing the same canonical payload:

```ts
// Named route
URL.signedRoute("unsubscribe", { user: id }, { expiresInSeconds: 86400 });

// Raw path
import { signedUrl } from "@mahiframework/http";
signedUrl("/verify-email", { id: user.id }, { expiresInSeconds: 3600 });
```

Verify on the receiving end:

```ts
import { validateSignature, hasValidSignature } from "@mahiframework/http";

// As middleware — 403s on missing/tampered/expired
router.get("/verify-email", verifyEmail).middleware(validateSignature());

// Or inline
if (!hasValidSignature(request)) { /* … */ }
```

**The canonical payload is order-independent.** `canonicalPayload()` sorts
params by key before building the query string, so a link whose params get
reordered in transit (by a mail client, a redirect, a copy-paste) still
verifies.

**Omitting `expiresInSeconds` produces a non-expiring signature.** No
`expires` param is added and no expiry is checked. That's the right default
for something like a permanent unsubscribe link, and the wrong one for a
password reset, be deliberate.

`signature` and `expires` are reserved. Passing either as a route param to
`signedRoute()` throws:

```
"signature" and "expires" are reserved parameters when signing a route.
```

`signedRoute()` always signs the **relative** path, even when returning an
absolute URL, because `hasValidSignature()` rebuilds the payload from
`request.path()`. Which is never absolute. Signing the absolute form would
make every link fail verification behind a proxy that rewrites the host.

## The global middleware pipeline

`HttpKernel.collectFromProviders()` assembles one global pipe list,
installed as a single Hono `use("*")` handler ahead of route dispatch. The
order is fixed:

1. **Invocation scope.** `(request, next) => runInvocationScope(this.app, () => next(request))`.
   Outermost of everything, ahead of even the maintenance check. This is
   the event that identifies a new request: it assigns the request's
   [invocation id](../logging/#invocation-ids), so every log line from
   here on is correlatable back to it, and opens the matching
   [context](../container/) overlay and container resolution scope, so
   anything a downstream pipe or handler adds (current user, the request
   root the URL generator reads) is isolated to this request and cannot
   bleed into a concurrent one. Cost is one `AsyncLocalStorage.run` each.
2. **Maintenance mode**, if `MAINTENANCE_MODE_TOKEN` is bound. Ahead of every
   provider pipe, so a downed app short-circuits before auth, throttling, or
   anything else runs. When the app is up this is a cached check of the
   `storage/framework/down` marker file (re-read at most once a second).
3. **Every provider's `middleware()` hook**, in provider registration order,
   a provider earlier in `config/app.ts`'s `providers[]` runs its pipes
   before a later provider's.

```ts
export class AppServiceProvider extends ServiceProvider {
  middleware(): HttpPipe[] {
    return [trustProxies(["10.0.0.0/8"]), trustHosts(["example.com"])];
  }
}
```

These run through `@mahiframework/pipeline`'s `Pipeline`, not Hono's own middleware
composition, so ordering is the array order you can read in your provider
list rather than Hono's registration semantics.

Ahead of all of it, installed in the `HttpKernel` **constructor** and so
running before any provider's routes: security headers, the request body
limit, and CORS (when configured). See
[Built-in protections](#built-in-protections).

## Built-in protections

Three things are on by default, with no configuration. Each has an entry
in the `http` config namespace to tune or disable it.

### Request body limit

The framework parses every request body eagerly, in the global pipe,
before any route decision, so an unbounded body is a memory-exhaustion
DoS reachable on paths that don't even exist. Bodies are capped at
**1 MiB** (JSON/urlencoded) and **10 MiB** (`multipart/form-data`);
exceeding either returns `413` in the normal JSON envelope.

```ts
// config/http.ts
bodyLimit: {
  maxBytes: 1024 * 1024,
  maxMultipartBytes: 10 * 1024 * 1024,
}
```

Uploads are buffered in memory, so `maxMultipartBytes` bounds memory per
in-flight request. Set either to `0` to disable that limit.

### Security headers

Every response carries `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`.
`Strict-Transport-Security` is added **only** when the request is already
secure, behind a TLS terminator that means `trustProxies()` must be
configured, or `request.secure()` is false and the header is never sent.

```ts
securityHeaders: {
  frameOptions: false,             // omit one
  referrerPolicy: "same-origin",   // or override it
  extra: { "Content-Security-Policy": "default-src 'self'" },
}
```

Headers are only set when absent, so a handler that sets its own wins.
Set `{ enabled: false }` to install none.

### JSON 404 and 405

An unmatched route returns `{"message":"Not Found"}`, not Hono's plain
text, so a client never has to parse two different error shapes. A known
path requested with the wrong method returns **405** with an `Allow`
header listing what would have worked, rather than a 404 that sends the
caller looking for a deployment problem.

## Rate limiting

`throttle()` is a pipe backed by `@mahiframework/cache`'s `RateLimiter`. It has two
forms.

**Inline**, a plain options object:

```ts
router.post("/todos", createTodo)
  .middleware(throttle({ max: 20, windowSeconds: 60 }));

router.post("/todos", createTodo)
  .middleware(throttle({
    max: 20,
    windowSeconds: 60,
    key: (request) => request.user()?.id ?? request.ip() ?? "unknown",
  }));
```

| Option | Type | Default |
|---|---|---|
| `max` | `number` |: |
| `windowSeconds` | `number` |: |
| `key` | `(request) => string` | `request.ip() ?? "unknown"` |

The cache key is `throttle:<key>:<route pattern>`, the **pattern**
(`/posts/{post}`), not the concrete path. Keying on the concrete path
would give `/posts/1` and `/posts/2` separate buckets, so any enumerable
id turns an N/minute limit into N-per-id/minute.

The default key is `request.ip()`, which is the socket peer unless
[`trustProxies()`](#trusted-proxies-and-hosts) is configured. It is
**not** read from `X-Forwarded-For`, which any client can forge. Note it
also can't separate clients behind one NAT, and is `"unknown"` when there
is no peer. For anything guarding a specific account, key on the identity
too:

```ts
limiter.for("login", (request) =>
  Limit.perMinute(5).by(`${request.input("email")}|${request.ip() ?? "unknown"}`));
```

Keying on IP alone lets an attacker spread guesses for one account across
many addresses; keying on email alone lets them lock a victim out of
their own account. Combining them bounds both.

**Named**, a string referring to a limiter registered via
`RateLimiter.for()`, usually in a provider's `boot()`:

```ts
export class AppServiceProvider extends ServiceProvider {
  boot(): void {
    const limiter = this.app.make<RateLimiter>(RATE_LIMITER_TOKEN);

    limiter.for("login", async (request: Request) =>
      Limit.perMinute(5).by(await loginKey(request)));
    limiter.for("create-post", (request: Request) =>
      Limit.perMinute(30).by(request.ip() ?? "unknown"));
  }
}
```

```ts
router.post("/auth/login", LoginController).middleware(throttle("login"));
```

Named limiter callbacks may return several `Limit`s (stacked limits: "30 a
minute AND 1000 a day"). All of them are checked. Keys are prefixed
`throttle:<limiterName>:<limit.key>`. A callback returning `Limit.none()`
(an `Unlimited`) skips limiting entirely for that request. Referencing an
unregistered name throws:

```
Rate limiter "uploads" is not defined. Register it via RateLimiter.for().
```

`Limit` offers `perSecond`, `perMinute`, `perMinutes`, `perHour`, `perDay`,
`none`, plus `.by(key)`, `.after(callback)` (only count a hit when the
callback says so, "count failed logins only") and `.response(callback)`
(custom 429 body).

### Headers

Every response passing through `throttle()` gets:

| Header | When |
|---|---|
| `X-RateLimit-Limit` | Always: the limit's `maxAttempts` |
| `X-RateLimit-Remaining` | Always |
| `Retry-After` | Only when remaining is `0`: seconds until the window resets |
| `X-RateLimit-Reset` | Only when remaining is `0`: unix seconds when the window resets |

Exceeding the limit returns `429` with body `{"message":"Too Many Requests"}`
and the same headers, unless the `Limit` has a `.response()` callback.

## Trusted proxies and hosts

`request.ip()` is the **socket peer address**, the machine that actually
opened the connection. It never reads `X-Forwarded-For` on its own,
because a header is just something the client typed: honouring it by
default means an attacker chooses their own identity for rate limiting,
IP allow-lists and audit logs.

That is safe but incomplete behind a load balancer, where the peer is the
balancer and every client looks identical. `trustProxies()` is the trust
boundary that fixes it. It reads the forwarding headers only when the
peer is a proxy you have named:

```ts
export class AppServiceProvider extends ServiceProvider {
  middleware(): HttpPipe[] {
    return [trustProxies(["10.0.0.0/8"])];
  }
}
```

Patterns may be an exact IP, an IPv4 CIDR block (`10.0.0.0/8`), or `"*"`.
IPv6-mapped IPv4 addresses (`::ffff:1.2.3.4`) are normalized before
matching.

> `"*"` trusts whatever opened the socket. That is only correct when the
> app is genuinely unreachable except through a proxy that **overwrites**
> `X-Forwarded-For`. On a directly reachable host it is equivalent to no
> trust boundary at all, because the "proxy" is then the attacker.

**The chain is walked right-to-left.** Proxies *append*, so
`X-Forwarded-For: <client>, <hop1>, <hop2>` has the most trustworthy
entry last; everything to its left was copied from whatever the previous
hop received, including anything the client made up. `trustProxies()`
starts at the peer, walks left while each hop is a configured proxy, and
takes the first address that isn't one. Taking the *leftmost* entry, the
common naive implementation, hands the attacker their own forgery back.

When the peer cannot be determined at all (an in-process dispatch, a
non-Node adapter) it **fails closed**: `ip()` is `undefined` and no
header is believed.

### Forwarded scheme and host

A trusted proxy's `X-Forwarded-Proto` / `-Host` / `-Port` are also applied
to the request, so `request.secure()`, `request.root()` and every
generated URL reflect what the *client* connected to. Without this, an
app behind a TLS terminator sees plain `http` and emits `http://` links
in password-reset and verification emails. Pass
`{ forwardedOrigin: false }` to resolve only the client IP.

### Trusted hosts

`trustHosts()` validates the effective host against an allow-list and
403s otherwise. The URL generator prefers the live request's host, so
without it an attacker sends `Host: evil.example` to "forgot password"
and the victim receives a genuine, correctly signed link pointing at the
attacker's server:

```ts
trustHosts(["example.com", "*.example.com"]);
```

A leading `*.` matches subdomains and the bare domain. The port is
ignored, and IPv6 literals (`[::1]:3000`) are handled. `hostsFromUrl()`
derives the list from a configured `APP_URL` so you don't maintain your
hostname twice. That is what the scaffolded app does.

Both are opt-in. Nothing changes unless you install them, the same
"no magic defaults" stance as CORS.

## CORS

CORS is **opt-in**. Nothing is installed unless the app sets the
`http.cors` config namespace:

```ts
// config/http.ts
import type { HttpConfig } from "@mahiframework/http";

export function httpConfig(env: Env): HttpConfig {
  return {
    url: env.APP_URL,
    cors: {
      origin: env.CORS_ORIGIN.split(",").map((o) => o.trim()),
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    },
  };
}
```

| Key | Type |
|---|---|
| `origin` | `string \| string[]`: defaults to `hono/cors`'s own default (`"*"`) if omitted |
| `allowMethods` | `string[]` |
| `allowHeaders` | `string[]` |
| `exposeHeaders` | `string[]` |
| `credentials` | `boolean` |
| `maxAge` | `number` |

The config is passed straight to `hono/cors` and mounted on `*` in the
kernel constructor, ahead of every route.

## Health endpoints

Two separate opt-in routes, answering two different questions. Both are
configured in the `http` namespace:

```ts
export function httpConfig(): HttpConfig {
  return {
    liveness: {},       // GET /up      — is the process alive?
    healthCheck: {},    // GET /health  — should it receive traffic?
  };
}
```

### `GET /up`: liveness

`http.liveness`; present-but-empty enables it at `/up`, or set
`{ path: "/healthz" }`. Responds `200 {"status":"ok"}` and does **no I/O**.
Its path is added to the maintenance `except` list automatically, so it
keeps answering `200` while the app is down. An orchestrator has to be
able to tell a down-for-maintenance app from a dead one.

> Previously `http.health`. That key still works as a fallback, so existing
> apps keep running, but prefer `liveness`. The old name was too easy to
> confuse with `healthCheck` below.

### `GET /health`: readiness

`http.healthCheck`; requires `@mahiframework/health`. Runs every registered check
and returns `200`, or `503` if any failed. Unlike `/up` it is **not**
maintenance-exempt.

Keep these separate. A liveness failure means *restart the pod*, so `/up`
must never touch a dependency: one Redis blip would otherwise restart every
pod in the deployment at once. See [Health checks](../health/) for the full
reasoning, the `checks()` hook, and production redaction.

## Maintenance mode

```bash
./artisan maintenance:down
./artisan maintenance:down --retry 60 --secret hunter2 --message "Back shortly" --except /webhooks/*
./artisan maintenance:up
```

| Flag | Effect |
|---|---|
| `--retry <seconds>` | Sets the `Retry-After` header |
| `--secret <secret>` | Bypass secret |
| `--message <message>` | The 503 body's `message` field (default `"Service Unavailable"`) |
| `--status <code>` | Status to respond with (default `503`) |
| `--except <path...>` | Glob paths (`*` wildcard) that stay reachable |

State is a **marker file** at `storage/framework/down`, holding the
payload as JSON. `maintenance:down` runs in a different process from the
server, so a file (rather than cache state) is what makes the running
server actually see it, the previous cache-backed version, on the
default `array` driver, wrote the flag into the CLI's own heap and
exited, and the app kept serving traffic.

It is per-host, and `cache:clear` can't undo it. When the app is up the
check is a `stat` cached for a second, so a healthy request isn't paying
for a filesystem hit.

A request bypasses maintenance mode if it:

- sends `X-Maintenance-Secret: <secret>`,
- carries the bypass cookie, or
- has `<secret>` as its first path segment (`/hunter2`), which responds
  `302` to `/` and **sets** that cookie, so the browser works normally
  from then on and the secret stops appearing in URLs.

Secrets are compared with `timingSafeEqual`.

## `route:list`

```bash
./artisan route:list
```

Prints a table of `Method`, `URI`, `Name` for every registered route,
colour-coded by verb (Laravel's `RouteListCommand` colours). Paths are shown
in Hono `:param` form, since that's what Hono reports back through
`hono.routes`.

`captureRegisteredRoutes()` filters out Hono's synthetic `ALL` entries
(created by `use()` mounts) and de-duplicates, so a route with route-level
middleware appears once.

## The development server

```bash
./artisan serve                    # http://127.0.0.1:8000
./artisan serve --port 8080
./artisan serve --host 0.0.0.0
./artisan serve --tries 20         # walk up to 20 ports on EADDRINUSE
./artisan serve --no-reload        # don't restart on .env changes
```

By default a supervisor parent process watches `.env` (polled every 500ms)
and respawns a worker child when it changes. `--tries` only applies when the
port wasn't chosen explicitly, if you asked for `8080`, `bindWithRetries`
makes exactly one attempt rather than quietly serving on `8081`.

`serve` is the development server. For production, bind directly:

```ts
import { listenHttpServer } from "@mahiframework/http";

await app.bootstrap();
await listenHttpServer(app, { port: 8000 });
```

See [Deployment](../deployment/).

## Related

- [Requests](../requests/): reading input, route params, form requests
- [Controllers](../controllers/): single-action controllers
- [Responses](../responses/): what a handler returns
- [Service providers](../providers/): the `routes()` and `middleware()` hooks
- [Authentication](../authentication/): `authenticate()`, `authenticateOptional()`
- [Cache](../cache/): the `RateLimiter` behind `throttle()`
- [Encryption & hashing](../encryption/): the `Signer` behind signed URLs
