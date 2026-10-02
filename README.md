# Mahi

> **Work in progress.** Mahi is still being built. Things will change,
> break, and get renamed without warning. Don't use it in production yet.

[![CI](https://github.com/mahiframework/mahi/actions/workflows/ci.yml/badge.svg)](https://github.com/mahiframework/mahi/actions/workflows/ci.yml)
[![Release](https://github.com/mahiframework/mahi/actions/workflows/release.yml/badge.svg)](https://github.com/mahiframework/mahi/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@mahiframework/core?label=npm)](https://www.npmjs.com/package/@mahiframework/core)
[![node](https://img.shields.io/node/v/@mahiframework/core)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![license](https://img.shields.io/github/license/mahiframework/mahi)](./LICENSE)
[![docs](https://img.shields.io/badge/docs-bradietilley.dev%2Fmahi-6366f1)](https://bradietilley.dev/mahi/dev-main)

```bash
npm create mahi@latest my-app
cd my-app
./artisan serve
```

## About

Inspired by Laravel, whose best features are simplicity, elegance and structure.

Laravel's built using service providers, a container, managers resolving drivers,
an expressive ORM, queues, scheduling, events, all in predictable places with
predictable names. You can open any Laravel app and immediately know where things
live. That same predictability is why agents are so good at leveraging it: the
conventions are strong enough that "add an endpoint" or "add a queued job" has one
obvious, boring, correct answer. Bootstrapping an API becomes minutes of work.

The catch is PHP. It's a big runtime, it isn't especially portable, and the moment
your frontend is TypeScript you're running a two-language stack. Your Docker image
now carries PHP *and* Node. Your resource footprint effectively doubles. The whole
thing starts to feel clunky and worst of all, your backend literally doesn't speak
the same language as your frontend. So you reach for codegen: scrape the routes,
infer the request payloads, guess at the response shapes, emit some `.d.ts` files
and hope they stay honest. It works until it doesn't, and it's hacky at best.

Mahi keeps the structure and drops the language barrier. Same framework shape you
already know, all in TypeScript. Your app can ship a contracts package including
endpoints, request payloads, response payloads, resource shapes, that the backend
actually *implements* and the frontend *imports*. No codegen, no drift, and best
of all no translation layer. One shared interface, type-checked on both sides of
the app. And because it's TypeScript, you get real types: generics, unions,
discriminated results, inference that actually follows your data through the ORM
and out the other end. That's a feature PHP simply doesn't have.

That's Mahi. Laravel's ideas, TypeScript's type system, one language end to end.
Built with a lot of love, and a lot of opinions. Have a poke around.

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
  storage-ftp/          FtpStorageDriver — a disk on a legacy or appliance host, over FTP/FTPS
  storage-s3/           S3StorageDriver — a disk in object storage (S3, R2, Spaces, MinIO)
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

## Requirements

- Node.js 26 or later
- pnpm 9

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


## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for how to set up the monorepo,
run the test suites, and how releases are cut. Security vulnerabilities should be
reported privately per [SECURITY.md](.github/SECURITY.md).
