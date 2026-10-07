import type { ServiceProviderClass } from "@mahiframework/core";
import { LoggingServiceProvider } from "@mahiframework/core";
import { EventsServiceProvider } from "@mahiframework/events";
import { DatabaseServiceProvider } from "@mahiframework/database";
import { QueueServiceProvider } from "@mahiframework/queue";
import { ScheduleServiceProvider } from "@mahiframework/schedule";
import { CacheServiceProvider } from "@mahiframework/cache";
import { StorageServiceProvider } from "@mahiframework/storage";
import { EncryptionServiceProvider } from "@mahiframework/encryption";
import { AuthServiceProvider } from "@mahiframework/auth";
import { AuthorizationServiceProvider } from "@mahiframework/authorization";
import { ConsoleServiceProvider } from "@mahiframework/cli";
import { HttpServiceProvider } from "@mahiframework/http";
import { BroadcastServiceProvider } from "@mahiframework/broadcasting";
import { RedisServiceProvider } from "@mahiframework/redis";
import { MailServiceProvider } from "@mahiframework/mail";
import { NotificationsServiceProvider } from "@mahiframework/notifications";
import { HealthServiceProvider } from "@mahiframework/health";
import { AppServiceProvider } from "../src/providers/app.provider.js";

/**
 * Provider boot order matters: `boot()` runs sequentially in this order,
 * and a provider may rely on an earlier one already being booted.
 *
 * The ordering constraints that actually bite, in this list:
 *
 * - `EventsServiceProvider` before anything that dispatches events during
 *   its own `boot()`.
 * - `DatabaseServiceProvider` before anything that queries during boot,
 *   including `QueueServiceProvider`, whose `database` connection resolves
 *   the `DatabaseManager`.
 * - `ScheduleServiceProvider` after `QueueServiceProvider`, so a task
 *   using `schedule.job(...)` finds a bound `QUEUE_TOKEN`. (Soft
 *   dependency, `schedule()` hooks that don't call `.job()` are fine
 *   either way.)
 * - `CacheServiceProvider` before `HttpServiceProvider`, since
 *   `throttle()`'s `RateLimiter` resolves the default cache store.
 * - `AuthServiceProvider` after Database (user lookups + its own
 *   `personal_access_tokens`/`sessions` tables), after Encryption
 *   (`HASHER_TOKEN` for passwords, `SIGNER_TOKEN` for signed session
 *   cookies), and before Http so `AUTH_TOKEN` is bound, and its global
 *   auth-scope pipe collected, before routes and middleware are.
 * - `AuthorizationServiceProvider` after Auth (its gate resolves the
 *   current user through `AUTH_TOKEN`) and before Http, so `GATE_TOKEN`
 *   is bound before routes referencing `can()` are collected.
 * - `BroadcastServiceProvider` after Events (it decorates the dispatcher
 *   with an `afterDispatch()` hook) and after Http (it mounts its
 *   websocket upgrade endpoint onto the already-constructed kernel).
 * - `RedisServiceProvider` after Cache/Queue/Broadcast, its `register()`
 *   extends each of those managers with a `redis` driver, so their tokens
 *   must already be bound. It is inert until some config points at
 *   `"redis"`, so listing it costs nothing without a running Redis.
 * - `NotificationsServiceProvider` after Database (it owns the
 *   `notifications` table), Mail, and Events, its channel factories
 *   resolve those tokens at `register()` time.
 * - `HealthServiceProvider` is grouped after Cache/Database/Storage for
 *   readability, its three built-in checks probe those, but it has no
 *   hard ordering constraint at all, in either direction. Its checks
 *   resolve their tokens lazily at probe time, not at boot; `HttpKernel`
 *   tests `app.has(HEALTH_TOKEN)` after every provider's `register()` has
 *   run, so `GET /health` mounts whether Http comes before or after it;
 *   and its own `boot()` walks every provider, so `checks()` hooks are
 *   collected from providers listed after it too.
 *
 * `LoggingServiceProvider`, `EncryptionServiceProvider`, and
 * `MailServiceProvider` have no ordering dependency either way; they're
 * grouped with the other always-on infrastructure providers.
 *
 * Framework providers first, then your own. Add yours at the bottom.
 */
export const providers: ServiceProviderClass[] = [
  EventsServiceProvider,
  DatabaseServiceProvider,
  QueueServiceProvider,
  ScheduleServiceProvider,
  CacheServiceProvider,
  StorageServiceProvider,
  EncryptionServiceProvider,
  AuthServiceProvider,
  AuthorizationServiceProvider,
  LoggingServiceProvider,
  ConsoleServiceProvider,
  HttpServiceProvider,
  BroadcastServiceProvider,
  RedisServiceProvider,
  MailServiceProvider,
  NotificationsServiceProvider,
  HealthServiceProvider,

  AppServiceProvider,
];
