# Mahi

A TypeScript application framework for building APIs and services on Node.js.

Mahi takes the architecture that makes Laravel productive, service
providers with a two-stage lifecycle, a service container, driver-based
managers, an expressive ORM, first-class queues and scheduling, and
rebuilds it for TypeScript, where the type system does work that PHP's
runtime magic had to do at runtime.

```ts
export class PostsServiceProvider extends ServiceProvider {
  routes(router: Router): void {
    router.get("/posts/{post}", ShowPostController).name("posts.show");
  }
}

export class ShowPostController extends Controller {
  async handle(request: Request) {
    const post = await request.model(Post);
    await post.load("author", "comments");

    return HttpResponse.json(await new PostResource(post).toJson());
  }
}
```

## Getting started

```bash
npm create mahi@latest my-app
cd my-app
./artisan serve
```

See the [installation guide](./installation/) for the full walkthrough.

## Design principles

These are the decisions that shape everything else, and the places Mahi
deliberately diverges from Laravel.

**Explicit resolution, no decorators.** There is no `reflect-metadata`, no
`@Injectable`, no constructor auto-wiring. A service provider binds a
factory; consumers call `app.make(TOKEN)`. Resolution is a function call
you can read and follow, and the container never has to guess what a
constructor parameter means.

**Types are the documentation.** `data_get(user, "profile.city")` is
checked against `user`'s shape at compile time and returns the type at
that path. `request.validated()` returns a type derived from the rules you
declared. A model's `with("author")` narrows the result type to include
the loaded relation. Where Laravel returns `mixed` and asks you to know,
Mahi returns a type.

**No dynamic facade proxies.** Laravel's facades forward arbitrary method
names at runtime, which no type checker can follow. Mahi's facades are
hand-written classes with real static methods that each proxy exactly one
token, so renaming an underlying method is a compile error, not a runtime
surprise.

**Synchronous driver resolution.** `manager.driver()` never returns a
promise. Constructing a driver handle is cheap; real I/O is lazy. Drivers
that genuinely need async setup implement `Connectable` and are connected
by their owning provider's `boot()`.

**Escape hatches are first-class.** Every abstraction exposes the layer
below it: `builder.toBase()` for the query builder, `.raw()` for the
underlying Kysely query, `Expression.raw()` for literal SQL,
`request.raw()` for the Hono context. You should never have to fight the
framework to do something it didn't anticipate.

## Documentation

### Getting started

- [Installation](./installation/): creating and running a new application
- [Configuration](./configuration/): config files, environment variables
- [Application lifecycle](./lifecycle/): bootstrap, the two-stage boot
- [Deployment](./deployment/): running in production

### Core concepts

- [Service container](./container/): binding and resolving services
- [Service providers](./providers/): the extension point for everything
- [Helpers](./helpers/): `Str`, `Arr`, `Collection`, `Number`, `data_get`

### The HTTP layer

- [Routing](./routing/): routes, groups, middleware, named routes, URLs
- [Requests](./requests/): input, files, form requests
- [Validation](./validation/): rules, custom messages, typed output
- [Controllers](./controllers/): single-action controllers
- [Responses](./responses/): JSON, files, redirects, API resources

### Database

- [Getting started](./database/): connections, the query builder, transactions
- [Models](./models/): attributes, casts, events, serialization
- [Extending package models](./extending-models/): subclassing and swapping a package's models
- [Relationships](./relationships/): defining and eager-loading relations
- [Queries](./queries/): the fluent query builder in depth
- [Migrations](./migrations/): schema, seeders, factories
- [Pagination](./pagination/): length-aware, simple, and cursor paginators

### Security

- [Authentication](./authentication/): guards, tokens, sessions, passwords
- [Authorization](./authorization/): gates, policies, abilities
- [Permissions](./permissions/): roles, permissions, cached checks
- [Multi-factor auth](./mfa/): TOTP, email codes, recovery codes, step-up
- [Impersonation](./impersonation/): acting as another user, gated
- [Encryption & hashing](./encryption/): `Crypt`, `Hash`, signed URLs
- [Activity logs](./activity-logs/): resource, security and custom activity records

### Infrastructure

- [Cache](./cache/): stores, locks, rate limiting
- [Queues](./queues/): jobs, workers, retries, chaining
- [Scheduling](./scheduling/): recurring tasks
- [Events](./events/): dispatching and listening
- [Broadcasting](./broadcasting/): websockets
- [Storage](./storage/): file disks
- [Media](./media/): uploads, collections, image modifiers, archives
- [Mail](./mail/): mailables and transports
- [Notifications](./notifications/): multi-channel notifications
- [Health checks](./health/): readiness probes, `/health`, `./artisan health`
- [Logging](./logging/): channels and stacks
- [Redis](./redis/): the multi-process story
- [HTTP client](./http-client/): outbound requests, retries, fakes

### Tooling

- [Console](./console/): `artisan`, writing commands
- [Testing](./testing/): the test application, fakes, assertions
- [Dates & times](./datetime/): the `DateTime` API

## Packages

Mahi is a set of packages, not a monolith. Install what you use.

| Package | Contents |
|---|---|
| `@mahiframework/core` | Container, Application, ServiceProvider, Config, Env, Logger, `Str`/`Arr`/`Collection`, helpers |
| `@mahiframework/http` | HTTP kernel (Hono), router, request, responses, resources, middleware |
| `@mahiframework/database` | Models, query builder, relations, migrations, factories, seeders |
| `@mahiframework/validation` | `Rule`, `Validator`, `ValidationException` |
| `@mahiframework/auth` | Guards (token, session), user providers, password reset, verification |
| `@mahiframework/authorization` | Gates, policies, abilities |
| `@mahiframework/permissions` | Roles, permissions, cached authorization checks |
| `@mahiframework/impersonation` | Impersonation gate, start/stop, nested chains |
| `@mahiframework/cache` | Cache stores, locks, rate limiter |
| `@mahiframework/queue` | Jobs, queue drivers, workers, middleware |
| `@mahiframework/schedule` | Recurring task scheduling |
| `@mahiframework/health` | Readiness checks, `GET /health`, `./artisan health` |
| `@mahiframework/events` | Event dispatcher, listeners |
| `@mahiframework/broadcasting` | Websocket broadcasting |
| `@mahiframework/storage` | Filesystem disks |
| `@mahiframework/storage-ftp` | An FTP disk, for files on a legacy or appliance host |
| `@mahiframework/storage-s3` | An S3 disk, for files in object storage |
| `@mahiframework/storage-sftp` | An SFTP disk, for files on a remote host |
| `@mahiframework/media` | Uploads, collections, image modifiers, streaming archives |
| `@mahiframework/mail` | Mailables, SMTP/log transports |
| `@mahiframework/notifications` | Multi-channel notifications |
| `@mahiframework/encryption` | Encrypter, hasher, signer |
| `@mahiframework/activity-logs` | Resource/security/custom activity records |
| `@mahiframework/redis` | Redis-backed cache/queue/broadcast drivers |
| `@mahiframework/cli` | Console kernel, `make:*` generators, migration commands |
| `@mahiframework/testing` | Test application, HTTP client, database assertions |
| `@mahiframework/datetime` | Immutable date/time library |
| `@mahiframework/snowflake` | Distributed 63-bit IDs |
| `@mahiframework/tui` | Terminal UI: prompts, tables, spinners, progress bars |
| `@mahiframework/pipeline` | Send a value through a series of pipes |
| `@mahiframework/process` | Run external commands |
| `@mahiframework/http-client` | Outbound HTTP: fluent requests, retries, `Http.fake()` |
| `@mahiframework/facades` | The `Facade<T>` mixin |

## Requirements

- Node.js 22 or later
- No PHP, no compiled extensions beyond `better-sqlite3` and `argon2`
