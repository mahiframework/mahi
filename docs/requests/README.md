# Requests

`Request` is the object every route handler, middleware pipe, and
controller receives. It wraps Hono's context after a **single eager body
parse**, then exposes a fully synchronous, Laravel-shaped accessor surface.

```ts
export class GetPostController extends Controller {
  async handle(request: Request) {
    const post = await request.model(Post);
    return HttpResponse.json(await new PostResource(post).toJson());
  }
}
```

App code never takes a Hono `Context`. The kernel constructs one `Request`
per call and threads it through every pipe and into the handler.
`request.raw()` is the escape hatch back to Hono if you need it.

## Construction

| Constructor | Use |
|---|---|
| `Request.from(c)` | From a Hono `Context`. Parses the body once, caches the instance on the context. Async. |
| `Request.create(path, method?, input?, extras?)` | Unit tests and non-HTTP callers. Sync. |
| `Request.fromExisting(source)` | Upgrade a base `Request` into a subclass, reusing already-parsed bags. |
| `new Request(input?)` | Bare instance with only a body bag. |

`from()` is what the router calls. If the context already carries a
`Request` (because a global pipe built one earlier), it re-reads the route
params and returns that instance rather than re-parsing the body.

`create()` is what you'll use in tests:

```ts
const request = Request.create("/posts", "POST", { body: "hello" }, {
  query: { page: "2" },
  params: { post: "42" },
  files: { image: someFile },
  headers: { "content-type": "application/json" },
  ip: "1.2.3.4",
});
```

`RequestCreateExtras` accepts `query`, `headers`, `files`, `params`, and
`ip`. When `query` is omitted it's parsed out of the `path` string.

`ip` is the simulated **socket peer**, which is what `request.ip()`
returns. Setting an `x-forwarded-for` header does not change `ip()`. See
[IP precedence](#ip-precedence).

`fromExisting()` is how form requests work. See
[Form requests](#form-requests). If the source is already an instance of
the target class it's returned as-is; otherwise a new instance copies every
bag by reference (including the shared bag and the model cache, so
authorization and the handler share one fetched model) and takes over the
context's cached-request slot.

## The input bag

Three sources merge into one bag, later winning:

```
route params  →  query string  →  body
```

```ts
// GET /posts/42?v=query  with body { v: "body" }
request.input("v");      // "body"

// GET /posts/42?v=query  with no body
request.input("v");      // "query"
```

`rebuildInput()` recomputes the merge whenever the body bag changes
(`merge`, `mergeIfMissing`, `replace`) or route params are re-synced.

> **Why params re-sync:** a global `use("*")` pipe constructs the `Request`
> *before* Hono has matched a route, so `c.req.param()` is empty at that
> point. `syncRouteParams(c)` re-reads them when the route handler (or a
> route-level pipe) runs. You never call this yourself, but it explains why
> `request.route("post")` is empty inside a global pipe and populated inside
> the handler.

### Body parsing

Parsing is driven entirely by `Content-Type`:

| Content-Type | Behaviour |
|---|---|
| `application/json`, `*+json` | Parsed with `c.req.json()`. **Invalid JSON, `null`, or a top-level array all become `{}`.** |
| `multipart/form-data` | Parsed with `parseBody({ all: true })`. `File` values (and arrays of `File`) go to the file bag; everything else through the bracket parser into the input bag. |
| `application/x-www-form-urlencoded` | Same as multipart. |
| Anything else | Body ignored; input is route params + query only. |

Bodies are capped before they are read, 1 MiB, or 10 MiB for multipart.
Over the limit is a `413`; see
[Built-in protections](../routing/#built-in-protections).

Malformed JSON becoming `{}` rather than throwing is deliberate: validation
decides whether an empty body is an error. A rate limiter keying on
`request.input("email")` runs before validation and must tolerate garbage.
See the `loginKey()` helper in the generated `AppServiceProvider`.

### Bracket notation

Query strings and urlencoded bodies expand PHP/`qs`-style brackets, so
arrays and nested objects survive the trip:

```ts
// ?ids[]=1&ids[]=2
request.input("ids");            // ["1", "2"]

// ?user[name]=bob&user[role]=admin
request.input("user");           // { name: "bob", role: "admin" }

// ?items[0][id]=1&items[1][id]=2
request.input("items");          // [{ id: "1" }, { id: "2" }]
```

Without this, `ids` would be the single key `"ids[]"` holding `"1"`, the
second value silently dropped, and an `array()` validation rule on a query
field impossible to satisfy.

Values stay **strings**; shape is decided here, type by the validator.
(Coercing here would turn a zip code of `01234` into `1234`.) A repeated
plain key keeps the last value, as PHP does; write `a[]=1&a[]=2` when you
want both. Malformed keys (`a[b`) are kept verbatim rather than throwing,
and depth and array indices are bounded. The input is attacker-controlled.

`query()` returns the expanded bag. `query(key)` is typed
`string | undefined`, so a key holding an array or object reads as
`undefined` there; use `query()` or `input(key)` for those.
`queryString()` returns the raw, unexpanded string. Which is what
signature verification hashes.

Note that `{ all: true }` means a repeated field name yields an array.

### Reading input

| Method | Returns |
|---|---|
| `input()` | The whole merged bag (a copy) |
| `input(key, default?)` | One value, or `default` when the key is absent |
| `query()` | The whole query bag (a copy) |
| `query(key, default?)` | One query value, **query only**, ignoring params and body |
| `all()` | Same as `input()` |
| `only(...keys)` | Object with just those keys that are present |
| `except(...keys)` | Everything but those keys |
| `has(...keys)` | `true` when **every** key is present (own property) |
| `hasAny(...keys)` | `true` when **any** key is present |
| `filled(...keys)` | `true` when every key is present and not `undefined`/`null`/`""`. With **no arguments**, checks every key in the bag. |
| `missing(...keys)` | `true` when every key is absent |
| `collect(key?)` | A `Collection`: of the bag's values with no key; of the array/object's values with one |

Presence checks use `hasOwnProperty`, so an explicit `{ "note": undefined }`
counts as present for `has()` but not for `filled()`.

### Coercion

| Method | Returns |
|---|---|
| `boolean(key)` | `true` for `true`, `1`, `"1"`, `"true"`, `"on"`, `"yes"`, `false` otherwise |
| `integer(key)` | `parseInt(…, 10)`, or `undefined` for absent/`null`/`""`/non-finite |
| `float(key)` | `parseFloat`, same `undefined` rules |
| `string(key)` | `String(value)`, or `undefined` for absent/`null` |

These are for the form-encoded and query-string cases where everything
arrives as a string. Real type coercion with error reporting belongs in
[validation](../validation/).

```ts
export function perPageFrom(request: Request): number {
  const requested = request.integer("per_page");
  if (requested === undefined) return DEFAULT_PER_PAGE;
  return Math.min(MAX_PER_PAGE, Math.max(1, requested));
}
```

### Mutating input

| Method | Effect |
|---|---|
| `merge(values)` | Assign into the body bag (highest precedence), then rebuild |
| `mergeIfMissing(values)` | Same, but only for keys absent from the merged bag |
| `replace(values)` | Replace the body bag wholesale |

All three are fluent and mutate the body bag, route params and query are
untouched, and since body wins the merge, `merge()` always takes effect.
The main use is `prepareForValidation()`.

## URL and method

| Method | Returns |
|---|---|
| `method()` | Uppercased verb, e.g. `"POST"` |
| `isMethod(m)` | Case-insensitive comparison |
| `path()` | Path with a leading slash, no query |
| `url()` | `scheme://host/path`: no query string |
| `fullUrl()` | Full URL including query |
| `fullUrlWithQuery(q)` | `fullUrl()` with `q` merged in; a `null`/`undefined` value deletes that param |
| `root()` | `scheme://host` |
| `httpHost()` | Host (with port) |
| `scheme()` | `"http"` / `"https"` |
| `secure()` | `scheme() === "https"` |
| `is(pattern)` | Glob-match the path. `*` is the wildcard, everything else is escaped |

`root()` is also published into the per-request context overlay on
construction, which is how the [URL generator](../routing/#how-the-absolute-root-is-resolved)
borrows the live host for absolute URLs. Publishing is best-effort and
silently no-ops when there's no container (a unit-constructed request).

## Headers and client

| Method | Returns |
|---|---|
| `header(key, default?)` | Case-insensitive header lookup |
| `headers()` | Every header, keys lowercased (a copy) |
| `bearerToken()` | The token from `Authorization: Bearer …`, or `undefined` |
| `ip()` | Client IP: the socket peer, unless `trustProxies()` resolved one |
| `peerAddress()` | The immediate TCP peer, ignoring proxy resolution |
| `ips()` | The unvalidated `x-forwarded-for` chain, plus the peer last |
| `userAgent()` | The `user-agent` header |
| `setResolvedIp(ip)` | Set the authoritative IP (called by `trustProxies()`) |

### IP precedence

`ip()` returns the address that opened the socket, unless
[`trustProxies()`](../routing/#trusted-proxies-and-hosts) has established
that the peer is a trusted proxy and resolved a real client address from
`X-Forwarded-For`.

**`X-Forwarded-For` is never consulted otherwise.** It is a header, so
any client can set it to anything; a framework that reads it by default
lets an attacker pick their own rate-limit bucket, and gives every client
that sends no header at all a *shared* one, which turns a `throttle()`
on `/login` into a global lockout switch anyone can flip.

`ip()` is `undefined` only when there is genuinely no peer to name: an
in-process dispatch (`hono.request()` in tests) or a non-Node adapter.
Treat that as "unknown client", never as a usable identity.

`ips()` reports the raw forwarded chain with the socket peer appended,
closest hop last. Only that last entry is proven, so it is for
diagnostics; use `ip()` for decisions.

## Cookies

Reading them:

| Method | Returns |
|---|---|
| `cookie(name, prefix?)` | One inbound cookie, decoded, or `undefined` |
| `cookies()` | Every inbound cookie (a copy) |

Writing them, queued on the request, not on the response:

| Method | Effect |
|---|---|
| `queueCookie(name, value, options?)` | Queue a cookie for this request's response |
| `queueCookieForget(name, options?)` | Queue a deletion |
| `unqueueCookie(name, options?)` | Drop a queued cookie without writing a deletion |
| `queuedCookieHeaders()` | The queued cookies as `Set-Cookie` values |

```ts
request.queueCookie("theme", "dark", { maxAge: 31_536_000, sameSite: "Lax" });
```

`CookieOptions` covers `maxAge`, `expires`, `domain`, `path` (default
`"/"`), `secure`, `httpOnly`, `sameSite`, `partitioned`, `priority`, and
`prefix` (`"host"` → `__Host-`, `"secure"` → `__Secure-`, each forcing the
attributes the browser requires). Values are percent-encoded, and
anything a browser would silently discard, a `Max-Age` beyond the
400-day cap, an invalid name, a `;` inside an attribute, throws instead.

### Why queue rather than set on the response

Mahi handlers return **platform `Response` objects**. Hono only merges
its own context-queued headers into a response *it* built
(`c.json()`/`c.body()`/`c.newResponse()`), so a cookie set via
`hono/cookie` from framework code was silently dropped.

Queuing on the request also decouples *deciding* to set a cookie from
*building* the response. A pipe or guard, `SessionGuard.login()`,
`csrf()`, can queue one without knowing or caring what the handler
eventually returns, including when a later pipe short-circuits with a
401. The HTTP boundary drains the queue onto whatever response comes
back.

Queuing the same name (and `path`/`domain`) twice replaces the earlier
entry, so a guard re-issuing a sliding session emits one `Set-Cookie`
rather than two contradictory ones.

For a cookie a handler is setting *itself*, `HttpResponse.cookie()` is
more direct. See [Responses](../responses/).

### Content negotiation

| Method | Returns |
|---|---|
| `isJson()` | `Content-Type` contains `application/json` or `+json` |
| `accepts(...types)` | `true` if `Accept` contains `*/*`, or any listed type (substring, case-insensitive) |
| `prefers(types)` | The first listed type present in `Accept`, **falls back to `types[0]`**, never `undefined` in practice |
| `wantsJson()` | The **first** `Accept` entry mentions json |
| `expectsJson()` | `wantsJson() \|\| accepts("application/json", "json")` |

`prefers()` returning `types[0]` rather than `undefined` when nothing
matches means you can treat it as "the format to use", not "did they ask".
`wantsJson()` looks only at the first `Accept` entry, so a browser sending
`text/html,application/xhtml+xml,…,*/*` is *not* treated as wanting JSON,
while `expectsJson()` would say yes because of the `*/*`. Pick the strict
one for content negotiation and the loose one for error-format decisions.

## Files

Uploaded files never enter the input bag. They live in a separate bag, so
`request.input("image")` is `undefined` while `request.file("image")` is
the `File`.

| Method | Returns |
|---|---|
| `file(key)` | The `File`, or the first of an array, or `undefined` |
| `files(key)` | Always an array, `[]` when absent, `[file]` when single |
| `hasFile(key)` | Whether the key is in the file bag |
| `allFiles()` | The whole file bag (a copy) |

These are Web-standard `File` objects. Validation reaches them because
`Validator` is constructed with both bags, `new Validator(this.all(),
this.allFiles(), rules)`, so `fileRule().image().max(5120)` works against
a field that isn't in `all()`.

## Route parameters

| Method | Returns |
|---|---|
| `route()` | Every route param (a copy) |
| `route(name)` | One param, or `undefined` |
| `parameter(name)` | One param: **throws** if absent |

`parameter()` is the right call when the route pattern guarantees the
segment, since it removes the `undefined` from the type:

```ts
const username = request.parameter("username");   // string
const user = await User.query().where("username", username).first();
```

The message is `Expected route param "username" to be present.`

## Route-model binding

```ts
const post = await request.model(Post);              // reads {post}
const author = await request.model(User, "author");  // reads {author}
```

Binding is **explicit**. There is no implicit type-hint resolution,
because there are no decorators or runtime type reflection to hang it on.
You call `model()` where you want the fetch to happen.

- The param name defaults to `ModelClass.routeParamName()`, derived from
  `static morphName` when set (`morphName = "Post"` → `"post"`), else the
  lowercased class name, falling back to `"id"` for classes that don't
  expose one.
- **404 if the param is missing** (`HttpError.notFound()`).
- **404 if the row doesn't exist.**
- **Cached per request**, keyed `${ModelClass.table}:${param}`. So a form
  request's `authorize()` and the controller's `handle()` calling
  `request.model(Post)` hit the database once, not twice.

The signature is structural (`{ table, Row, find, routeParamName? }`)
rather than `typeof Model`, so concrete models with a typed `Row` stay
assignable, `Collection`'s variance rejects the nominal form.

See [Models](../models/) for `morphName` and `routeParamName`.

## Per-request storage

| Method | Effect |
|---|---|
| `share(key, value)` | Stash a value on this request (fluent) |
| `shared<T>(key)` | Read it back |

The shared bag is carried across `fromExisting()` upgrades, so a global pipe
can `share("requestId", …)` and a form request read it. It's a plain `Map`
scoped to the request, for cross-cutting values that should also be visible
to code that doesn't hold the request (loggers, the URL generator), use the
[context](../container/) instead.

## The current user

```ts
const user = request.user<UserTable>();
```

A thin delegate to `Auth.userOrNull()` when `@mahiframework/auth` is bound, and
`undefined` otherwise. It is **not** a second user-storage mechanism. It
resolves the `"auth"` token and calls through. Prefer `Auth.user()` /
`Auth.id()` directly in controllers; `request.user()` exists so framework
code (like a rate-limiter key callback) can ask without a hard dependency
on the auth package.

## Form requests

A form request is a `Request` subclass carrying validation rules and,
optionally, authorization. Generate one with `./artisan make:request`.

```ts
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

The `as const` matters: it preserves the literal shape of the rules object
so `validated()` can infer a precise return type. See
[typed output](../validation/#typed-output).

### `authorize()`

```ts
authorize(): boolean | void | Promise<boolean | void>
```

**Defaults to `true`.** A request that doesn't override it imposes no gate.

**Only an explicit `false` produces a 403.** The controller pipeline checks
`allowed === false`, `undefined` (from a `void`-returning override) and
`true` both pass. That's what makes delegating to `@mahiframework/authorization`
work: `authorize("create", Post)` returns `Promise<void>` and *throws* on
denial, so it never returns `false` and the check is a no-op for it.

You may also throw `HttpError.forbidden()` directly. Both routes give a
403; the error propagates to the central handler.

This is offered as a Laravel-shaped place to put authorization, not an
enforced one. Authorizing inside the controller's `handle()` is equally
supported, and is what you want when the check needs the model loaded
first:

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

### `rules()`

Returns a `Record<string, Rule>`. Empty by default. A base `Request` runs
no validation, and `controllerToHandler` skips validation entirely when
`rules()` is empty rather than constructing a `Validator` that would pass
trivially.

### `prepareForValidation()`

Override it to normalize input via `merge()` / `mergeIfMissing()`:

```ts
override prepareForValidation(): void {
  this.merge({ email: String(this.input("email") ?? "").toLowerCase() });
}
```

May be sync or async. In a controller it runs **first, before
`authorize()`** (Laravel's order), so authorization sees the prepared
input; a request that merges a tenant id or the current user and then
authorizes against it works as written. `validate()` also ensures it has
run, and it runs **once** either way.

### `passedValidation()`

A hook for a **second validation pass**, run once `rules()` has passed
and `validated()` is readable. It does not run when the field rules
failed, there is nothing to validate against yet.

This is the extension point for a check whose schema isn't known until
another field has been read, which `rules()` structurally cannot express:

```ts
export class CreateInstanceRequest extends Request {
  rules() {
    return {
      driver_key: rule().string().required().in(installedDriverKeys()),
      config: rule().object().optional(),
    } as const;
  }

  override async passedValidation(): Promise<void> {
    const { driver_key, config } = this.validated();
    // throws ValidationException keyed "config.<field>" on a bad field
    this.mergeValidated({ config: await checkDriverConfig(driver_key, config) });
  }
}
```

Report failures by throwing `ValidationException`. Its errors are
**merged** into the request's bag, so `validate()` returns `false`,
`errors()` reports them alongside any field errors, and `validateOrFail()`
(and therefore the controller pipeline) 422s. The validated payload is
dropped, so `validated()` throws rather than hand back a half-checked
object.

Any **other** error propagates untouched, so a pass that needs to 403 or
404 can throw an `HttpError` instead.

`mergeValidated(values)` shallow-assigns onto the validated payload, for
a pass that coerces or narrows a field it just checked. Keys you don't
name are left as the rules produced them. It throws when validation
hasn't produced a payload yet.

May be sync or async, and runs **once**: `validate()` is memoized, so a
second call (or a later `validateOrFail()`) doesn't re-run it.

### Running validation

| Method | Behaviour |
|---|---|
| `prepareInput()` | Runs `prepareForValidation()` once. Called by the controller pipeline and by `validate()`. |
| `validate()` | Prepares, runs the rules, then `passedValidation()`. Returns `Promise<boolean>`. **Memoized**. A second call returns the first result without re-running. |
| `passes()` | Alias for `validate()` |
| `fails()` | `!(await validate())` |
| `validateOrFail()` | `validate()`, throwing `ValidationException(errors)` on failure. Returns `this`. |
| `validated()` | The typed, validated payload. **Synchronous.** |
| `mergeValidated(values)` | Shallow-assign onto the validated payload. Fluent. For `passedValidation()`. |
| `errors()` | `Record<string, string[]>`: empty until `validate()` runs |

> **`validated()` throws before a successful `validate()`**, but only
> when there are rules to run.
>
> ```
> Error: validated() was called before a successful validate().
> ```
>
> `validatedPayload` is only assigned when validation **passes**, so this
> fires both when you forgot to validate and when validation failed. It's a
> plain `Error`, not an `HttpError`, a 500, because reaching it means the
> code is wrong, not the request.
>
> A request with **no rules** returns `{}` instead of throwing: nothing
> was validated, and `{}` says exactly that. This is what lets a
> controller typed against the base `Request` call `validated()` without
> first knowing whether its subclass happens to declare rules.
>
> Inside a controller that declares `request = CreatePostRequest`, the
> throwing case can't happen: the pipeline runs `validateOrFail()` before
> `handle()`. It applies when you construct and validate a form request by
> hand.

When rules are empty, `validate()` sets `validatedPayload` to `{}` and
returns `true`, so `validated()` on a rule-less request returns `{}`
rather than throwing.

Validating by hand, outside a controller:

```ts
const request = LoginRequest.fromExisting(incoming);
if (await request.fails()) {
  return HttpResponse.json({ errors: request.errors() }, 422);
}
const { email, password } = request.validated();
```

## Escape hatch

```ts
request.raw();   // Hono Context | undefined
```

`undefined` for requests built with `create()` or `new`. `trustProxies()`
uses it to reach `getConnInfo()` for the real peer address.

## Related

- [Validation](../validation/): the `Rule` API and typed output
- [Controllers](../controllers/): the per-request pipeline that runs `authorize()` and `validate()`
- [Routing](../routing/): path syntax and route parameters
- [Responses](../responses/): what to return
- [Models](../models/): `routeParamName`, `find`, `morphName`
- [Authentication](../authentication/): `Auth`, guards, `bearerToken()`
