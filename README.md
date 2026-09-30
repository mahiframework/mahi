# Mahi

> **Work in progress.** Mahi is still being built. Things will change,
> break, and get renamed without warning. Don't use it in production yet.

A TypeScript application framework for building APIs and services on
Node.js, service providers with a two-stage `register()`/`boot()`
lifecycle, a service container, Manager-based driver resolution, an
expressive ORM, an HTTP kernel (Hono), a CLI kernel (Commander), queues,
scheduling, and an event system. All plugin-extensible.

**[Read the documentation →](https://bradietilley.dev/mahi/dev-main)**

```bash
npm create mahi@latest my-app
cd my-app
./artisan serve
```

## This repository

This is the framework monorepo. If you want to *use* Mahi, you want
[`npm create mahi@latest`](https://bradietilley.dev/mahi/dev-main/installation) and the
[documentation](https://bradietilley.dev/mahi/dev-main), not this repo.

```
framework/            The framework packages (published as @mahiframework/*)
  core/                 Container, Manager, Application, ServiceProvider, Config, Env, Logger, Str/Arr/Collection, helpers
  events/               Event, Listener, EventDispatcher (wildcard + listenQueued)
  database/             DatabaseManager, SQLite/MySQL/Postgres drivers, MigrationRunner, Model, Seeder, Factory, transaction()
  queue/                QueueManager, Job, JobRegistry, Sync/Database/Fake drivers, queue:work
  schedule/             Schedule, ScheduledTask, cron matching, schedule:run/list/test/work
  cache/                CacheManager, ArrayCacheStore, FileCacheStore, Lock, RateLimiter, Limit
  storage/              StorageManager, LocalStorageDriver — Laravel-style "disk" abstraction
  storage-sftp/         SftpStorageDriver — a disk on a remote host, over SSH
  encryption/           Encrypter (AES-256-GCM), Hasher (argon2), Signer (HMAC), key:generate, Crypt/Hash facades
  auth/                 AuthManager, TokenGuard, SessionGuard, DatabaseUserProvider, authenticate()/csrf(), Auth facade
  authorization/        GateRegistry, Policy, requireAuth/requireGuest, can() middleware, Gate facade
  facades/              Facade<T> mixin factory — base for the Events/Bus/Crypt/Hash facades
  cli/                  ConsoleKernel, Command, built-in commands (migrate, db:seed, make:*, ...)
  pipeline/             Pipeline, Hub — send a value through an ordered list of pipes
  process/              Process.run() — external commands, with a fake for tests
  http/                 HttpKernel (Hono), Router, Request, Resources, middleware
  validation/           Rule, Validator, ValidationException — fluent rules() with typed validated()
  broadcasting/         BroadcastManager, LocalBroadcastDriver (websockets), ShouldBroadcast — SINGLE-PROCESS ONLY
  redis/                RedisManager + Redis cache/queue/broadcast drivers — the multi-process story
  mail/                 MailManager, Mailable, SMTP/log/array transports
  notifications/        Notification, Notifiable, mail/database/broadcast channels
  testing/              createTestApplication(), TestClient — test helpers for apps built on Mahi
  snowflake/            Snowflake IDs (microsecond, 63-bit), HasSnowflake, Cache/File sequence resolvers
  datetime/             Immutable DateTime, Duration, Interval, Period
  tui/                  Terminal UI — prompts, tables, spinners, progress bars
  create-mahi/          The `npm create mahi@latest` scaffolder + the base app template

docs/                 The documentation
```

Each framework package owns its own test suite.
`framework/create-mahi/template/` is the in-tree base app the scaffolder
ships.

## Working on the framework

```bash
pnpm install
pnpm build
pnpm test
```

Turborepo drives the task graph. Run tests serially if your machine
oversubscribes:

```bash
pnpm turbo run test --concurrency=1
```

### Testing the scaffolder

`create-mahi` generates an app that depends on `@mahiframework/*` at published
versions. To scaffold against the working tree instead, use
`--link-workspace` to rewrite them to `workspace:*` and scaffold into
`.tmp-scaffold/` (a gitignored workspace member):

```bash
pnpm --filter create-mahi build
node framework/create-mahi/dist/index.js .tmp-scaffold/demo --no-install --no-git --link-workspace
pnpm install

cd .tmp-scaffold/demo
./artisan key:generate
./artisan migrate
./artisan serve
```

### Integration tests

The MySQL, Postgres, and Redis suites skip themselves when no server is
reachable. To run them locally against the same images CI uses:

```bash
pnpm test:integration     # docker compose up, then the full suite with CI_STRICT_MODE=true
pnpm services:down
```

### Releasing

Every `@mahiframework/*` package shares one version and is published together. To
cut a release:

```bash
pnpm version:set 0.2.0    # bumps every lockstep package + the create-mahi template pins
pnpm metadata:check && pnpm version:check && pnpm pack:check
git commit -am "release: v0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

The `Release` workflow builds, lints, typechecks, tests, verifies the tag
matches the lockstep version, and runs `pnpm -r publish`, which only
publishes packages whose version is not already on npm, so re-running a
release is safe. It authenticates to npm with trusted publishing (OIDC), so
there is no token to rotate: each package lists this repository and
`release.yml` as its trusted publisher.

## Documentation

Full documentation lives at
[bradietilley.dev/mahi](https://bradietilley.dev/mahi/dev-main) (source in
[`docs/`](./docs/)):

- [Installation](https://bradietilley.dev/mahi/dev-main/installation) · [Configuration](https://bradietilley.dev/mahi/dev-main/configuration) · [Lifecycle](https://bradietilley.dev/mahi/dev-main/lifecycle) · [Deployment](https://bradietilley.dev/mahi/dev-main/deployment)
- [Container](https://bradietilley.dev/mahi/dev-main/container) · [Providers](https://bradietilley.dev/mahi/dev-main/providers) · [Helpers](https://bradietilley.dev/mahi/dev-main/helpers)
- [Routing](https://bradietilley.dev/mahi/dev-main/routing) · [Requests](https://bradietilley.dev/mahi/dev-main/requests) · [Validation](https://bradietilley.dev/mahi/dev-main/validation) · [Controllers](https://bradietilley.dev/mahi/dev-main/controllers) · [Responses](https://bradietilley.dev/mahi/dev-main/responses)
- [Database](https://bradietilley.dev/mahi/dev-main/database) · [Models](https://bradietilley.dev/mahi/dev-main/models) · [Relationships](https://bradietilley.dev/mahi/dev-main/relationships) · [Queries](https://bradietilley.dev/mahi/dev-main/queries) · [Migrations](https://bradietilley.dev/mahi/dev-main/migrations) · [Pagination](https://bradietilley.dev/mahi/dev-main/pagination)
- [Authentication](https://bradietilley.dev/mahi/dev-main/authentication) · [Authorization](https://bradietilley.dev/mahi/dev-main/authorization) · [Encryption](https://bradietilley.dev/mahi/dev-main/encryption)
- [Cache](https://bradietilley.dev/mahi/dev-main/cache) · [Queues](https://bradietilley.dev/mahi/dev-main/queues) · [Scheduling](https://bradietilley.dev/mahi/dev-main/scheduling) · [Events](https://bradietilley.dev/mahi/dev-main/events) · [Broadcasting](https://bradietilley.dev/mahi/dev-main/broadcasting) · [Storage](https://bradietilley.dev/mahi/dev-main/storage) · [Mail](https://bradietilley.dev/mahi/dev-main/mail) · [Notifications](https://bradietilley.dev/mahi/dev-main/notifications) · [Logging](https://bradietilley.dev/mahi/dev-main/logging) · [Redis](https://bradietilley.dev/mahi/dev-main/redis) · [Health](https://bradietilley.dev/mahi/dev-main/health) · [HTTP client](https://bradietilley.dev/mahi/dev-main/http-client)
- [Console](https://bradietilley.dev/mahi/dev-main/console) · [Testing](https://bradietilley.dev/mahi/dev-main/testing) · [Dates & times](https://bradietilley.dev/mahi/dev-main/datetime)

## Requirements

- Node.js 22 or later
- pnpm 9
