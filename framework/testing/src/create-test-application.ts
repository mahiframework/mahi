import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Application } from "@mahiframework/core";
import { AUTH_TOKEN, type AuthManager } from "@mahiframework/auth";
import { CACHE_TOKEN, ArrayCacheStore, type CacheManager } from "@mahiframework/cache";
import { collectMigrationSources } from "@mahiframework/cli";
import { DATABASE_TOKEN, DatabaseManager, MigrationRunner } from "@mahiframework/database";
import { EVENTS_TOKEN, RecordingEventDispatcher } from "@mahiframework/events";
import { HTTP_KERNEL_TOKEN, HttpKernel } from "@mahiframework/http";
import { Http } from "@mahiframework/http-client";
import { Process } from "@mahiframework/process";
import { MAIL_TOKEN, RecordingMailManager, type MailConfig } from "@mahiframework/mail";
import { NOTIFICATIONS_TOKEN, RecordingChannelManager } from "@mahiframework/notifications";
import {
  FakeQueueDriver,
  JOB_REGISTRY_TOKEN,
  QUEUE_TOKEN,
  QueueManager,
  type JobRegistry,
} from "@mahiframework/queue";
import { STORAGE_TOKEN, StorageManager, FakeStorageDriver } from "@mahiframework/storage";
import {
  connectionEnv,
  connectionNameFor,
  createScratchDatabase,
  dropScratchDatabase,
  resolveTestEngine,
  type TestDatabaseEngine,
  type TestDatabaseOptions,
} from "./test-database.js";

/**
 * Snapshot the given `process.env` keys and return a function that puts
 * them back exactly as they were, including deleting a key that was
 * previously unset, which `env[key] = undefined` does not do (it sets the
 * literal string `"undefined"`).
 */
function captureEnv(keys: string[]): () => void {
  const snapshot = keys.map((key) => [key, process.env[key]] as const);

  return () => {
    for (const [key, value] of snapshot) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

export interface TestApplicationOptions {
  /**
   * Which database engine to boot the application against.
   *
   * Defaults to `"sqlite"`, which needs nothing running: the app gets a
   * temp file, as it always has. `"mysql"`/`"postgres"` create a
   * throwaway database on the server named by the `MAHI_TEST_*`
   * variables and drop it in `cleanup()`, so the suite runs against the
   * schema it actually deploys on.
   *
   *   const app = await createTestApplication(bootstrap, {
   *     database: "postgres",
   *   });
   *
   * Set `MAHI_TEST_ENGINE` to move a whole suite without editing test
   * files; this option wins over it where both are present.
   *
   * ⚠️ Gate the suite with `testEngineAvailable()` first, or a developer
   * with no docker running gets a connection error rather than a skip.
   *
   * Choosing is worth doing deliberately: SQLite is not a stand-in for
   * the engine you deploy on. `like` folds case on SQLite and does not
   * on Postgres, `lock()` is a documented no-op, SQLite has no type
   * affinity, and partial/GIN indexes cannot be created at all. Each of
   * those is a test that passes while asserting nothing.
   */
  database?: TestDatabaseEngine | TestDatabaseOptions;

  /**
   * Called with the booted Application, after `bootstrapFn()` resolves but
   * before migrations run, for extra `app.config.set`/`merge` calls or
   * test-only overrides that don't belong in the app's own bootstrap.
   * Note `bootstrapFn` itself is responsible for calling `app.bootstrap()`
   * (see the app's `bin/bootstrap.ts`), so this hook necessarily runs after
   * providers have already registered/booted, not before.
   */
  configure?: (app: Application) => void;

  /**
   * Swap the queue's *default* connection for a `FakeQueueDriver` (the
   * `Queue::fake()` equivalent) so `QueueManager.dispatch()` / `Bus`
   * records pushes instead of running them. The driver is returned as
   * `testApp.queue` for assertions (`assertPushed`/`pushed`/...).
   * Requires `@mahiframework/queue`'s `QueueServiceProvider` to be
   * registered; a no-op (leaving `testApp.queue` undefined) otherwise.
   */
  fakeQueue?: boolean;

  /**
   * Swap the `EventDispatcher` singleton for a `RecordingEventDispatcher`
   * (the `Event::fake()` equivalent) so `dispatch()` records events and
   * runs no listeners/queued-listeners/afterDispatch callbacks. The
   * dispatcher is returned as `testApp.events` for assertions
   * (`assertDispatched`/`dispatched`/...). Requires
   * `@mahiframework/events`' `EventsServiceProvider` to be registered; a
   * no-op (leaving `testApp.events` undefined) otherwise.
   */
  fakeEvents?: boolean;

  /**
   * Call `Http.fake()` so `@mahiframework/http-client` intercepts every outbound
   * request instead of reaching the network, and register `Http.restore()`
   * on `cleanup()`.
   *
   * Unlike `fakeQueue`/`fakeEvents` this needs no container swap and no
   * provider to be registered, `Http` is a static facade over
   * module-level state, so there is no `testApp.http`: assert with the
   * statics (`Http.assertSent(...)`) instead.
   *
   * Note the stub map is empty, and an unmatched request raises
   * `StrayRequestError` rather than reaching the network. Call
   * `Http.fake({ ... })` in the test itself to stub specific responses.
   */
  fakeHttp?: boolean;

  /**
   * Call `Process.fake()` so `@mahiframework/process` intercepts every command
   * instead of spawning one, and register `Process.restore()` on
   * `cleanup()`.
   *
   * Like `fakeHttp` (and unlike `fakeQueue`/`fakeEvents`) this is a static
   * facade over module-level state, so there is no `testApp.process`:
   * assert with the statics (`Process.assertRan(...)`).
   *
   * The stub map starts empty. An unmatched command returns a successful
   * empty result rather than throwing. `Process.fake()`'s own default,
   * left alone here so the behaviour does not depend on who turned it on.
   * Call `Process.fake({ "git *": ... })` in the test to stub specifics.
   *
   * Worth turning on broadly: a test that shells out unmocked is slow,
   * environment-dependent, and occasionally destructive.
   */
  fakeProcess?: boolean;

  /**
   * Swap the `MailManager` singleton for a `RecordingMailManager` (the
   * `Mail::fake()` equivalent) so `Mail.send()` / `MailManager.send()`
   * records mailables instead of delivering them. Returned as
   * `testApp.mail` for assertions (`assertSent(WelcomeMailable)`).
   * Requires `@mahiframework/mail`'s provider to be registered; a no-op otherwise.
   */
  fakeMail?: boolean;

  /**
   * Swap the notifications `ChannelManager` for a
   * `RecordingChannelManager` (the `Notification::fake()` equivalent) so
   * `Notifications.send()` records `(notifiable, notification)` pairs
   * instead of fanning out to channels. Returned as
   * `testApp.notifications` for assertions (`assertSentTo(user, Foo)`).
   * Requires `@mahiframework/notifications`' provider; a no-op otherwise.
   */
  fakeNotifications?: boolean;

  /**
   * Swap the named disks (or the default disk when `true`) for
   * `FakeStorageDriver`s rooted at fresh temp dirs (the
   * `Storage::fake($disk)` equivalent), so writes under test never touch
   * the app's real disk roots. Returned as `testApp.storage` keyed by disk
   * name for `assertExists`/`assertMissing`. Requires `@mahiframework/storage`'s
   * provider; a no-op otherwise.
   */
  fakeStorage?: boolean | string[];

  /**
   * Point the cache's default store at a fresh in-memory `ArrayCacheStore`
   * with its sweep timer disabled (the `Cache::fake()` equivalent), so
   * cache state is isolated per test and no interval keeps the event loop
   * alive. Requires `@mahiframework/cache`'s provider; a no-op otherwise.
   */
  fakeCache?: boolean;
}

export interface TestApplication {
  app: Application;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  cleanup: () => Promise<void>;
  /**
   * Re-run every migration from scratch against the same database
   * (`migrate:fresh`, drops all tables, re-migrates).
   *
   * Reach for this only when a test *changes the schema* and needs it
   * rebuilt. For the ordinary "wipe the rows between tests" case use
   * `clearDatabase()`, which is the same isolation for a fraction of
   * the cost: this re-runs every migration, which on MySQL or Postgres
   * is seconds per call and makes a `beforeEach()` unusable.
   */
  resetDatabase: () => Promise<void>;
  /**
   * Delete every row from every table, leaving the schema in place and
   * restarting auto-increment counters at 1. Laravel's
   * `DatabaseTruncation`, and the right default for per-`it()`
   * isolation:
   *
   *   beforeEach(() => testApp.clearDatabase());
   *
   * Preserves the `migrations` ledger, so the schema and the record of
   * how it was built stay in agreement.
   *
   * Unlike wrapping each test in a transaction and rolling it back,
   * this changes nothing about how the database behaves: commits are
   * real, `lock()`/`SELECT ... FOR UPDATE` still contend, and a second
   * connection or an out-of-process worker sees the same rows the test
   * does. Those are precisely the behaviours worth testing on a real
   * engine, so the reset must not be the thing that hides them.
   */
  clearDatabase: () => Promise<void>;
  /**
   * The `FakeQueueDriver` installed when `options.fakeQueue` was set,
   * `undefined` otherwise. Assert with `testApp.queue!.assertPushed(...)`.
   */
  queue?: FakeQueueDriver;
  /**
   * The `RecordingEventDispatcher` installed when `options.fakeEvents` was
   * set, `undefined` otherwise. Assert with
   * `testApp.events!.assertDispatched(...)`.
   */
  events?: RecordingEventDispatcher;
  /**
   * The `RecordingMailManager` installed when `options.fakeMail` was set,
   * `undefined` otherwise. Assert with `testApp.mail!.assertSent(...)`.
   */
  mail?: RecordingMailManager;
  /**
   * The `RecordingChannelManager` installed when `options.fakeNotifications`
   * was set, `undefined` otherwise. Assert with
   * `testApp.notifications!.assertSentTo(...)`.
   */
  notifications?: RecordingChannelManager;
  /**
   * The `FakeStorageDriver`s installed when `options.fakeStorage` was set,
   * keyed by disk name, empty otherwise. Assert with
   * `testApp.storage.public!.assertExists("avatars/1.png")`.
   */
  storage: Record<string, FakeStorageDriver>;
  /**
   * Set the acting (authenticated) user for requests driven through the
   * kernel, Laravel's `actingAs()`. Delegates to `AuthManager.actingAs()`,
   * so `authenticate()` resolves `user` for every subsequent request. Pass
   * `null` to clear. Requires `@mahiframework/auth`'s provider to be registered.
   */
  actingAs: (user: unknown, guard?: string) => void;
}

/**
 * Boots a real `Application` against a throwaway database, runs
 * migrations, and returns an in-process `request()` function backed by
 * the app's own Hono instance, the setup every app's test suite would
 * otherwise hand-roll, extracted once.
 *
 * Takes the app's own `bootstrapFn` (e.g. the app's `bin/bootstrap.ts`
 * `bootstrap`) as a parameter rather than importing it directly. This
 * package can't depend on any specific app, so it stays a generic helper
 * any app supplies its own bootstrap function to.
 *
 * Sets the database environment variables before calling `bootstrapFn`
 * so a typical `config/database.ts` reading them picks the throwaway
 * database up with no test-specific configuration, matching the
 * convention in the scaffolded `config/database.ts`. That is
 * `DB_FILENAME` for the default SQLite engine, and `DB_CONNECTION` plus
 * the `DB_HOST`/`DB_DATABASE`/... set when `options.database` selects
 * MySQL or Postgres. Also sets `APP_KEY` (if not already set) to a fresh
 * random key, so `EncryptionServiceProvider` (whose env schema entry has
 * no default, by design) doesn't fail `loadEnv()` validation in tests
 * that don't otherwise touch a real `.env` file.
 *
 * Pass `{ fakeQueue: true }` / `{ fakeEvents: true }` to swap in the
 * recording queue driver / event dispatcher (the `Queue::fake()` /
 * `Event::fake()` equivalents). The installed fake is returned as
 * `testApp.queue` / `testApp.events` to assert against. `{ fakeHttp: true }`
 * fakes outbound HTTP, asserted through the `Http` statics rather than a
 * property on the returned object.
 */
export async function createTestApplication(
  bootstrapFn: () => Promise<Application>,
  options: TestApplicationOptions = {},
): Promise<TestApplication> {
  const database = resolveTestEngine(options.database);
  const tmpDir = await mkdtemp(path.join(tmpdir(), "mahi-test-"));

  // Snapshot before mutating, restore in `cleanup()`. `process.env` is
  // process-global and outlives the Application, so a test file that
  // points `DB_FILENAME` at its own temp database would otherwise leave
  // it pointing there for every file that runs afterwards in the same
  // worker, at a path `cleanup()` has already deleted. The `DB_*`
  // connection keys are in the list for the same reason.
  const restoreEnv = captureEnv([
    "DB_FILENAME",
    "NODE_ENV",
    "APP_KEY",
    "DB_CONNECTION",
    "DB_HOST",
    "DB_PORT",
    "DB_DATABASE",
    "DB_USERNAME",
    "DB_PASSWORD",
  ]);

  // Set even on a server engine. It costs nothing, and it means an app
  // that resolves its sqlite connection for any reason writes to the
  // temp dir rather than into the repository.
  process.env.DB_FILENAME = path.join(tmpDir, "test.sqlite");
  process.env.NODE_ENV = "test";
  process.env.APP_KEY ??= `base64:${randomBytes(32).toString("base64")}`;
  process.env.DB_CONNECTION = connectionNameFor(database);

  const scratchDatabase = await createScratchDatabase(database.engine, database.label);

  if (scratchDatabase) {
    Object.assign(process.env, connectionEnv(database, scratchDatabase));
  }

  const app = await bootstrapFn();
  options.configure?.(app);

  const db = app.make<DatabaseManager>(DATABASE_TOKEN);
  const runner = new MigrationRunner(db.driver().kysely, db.driver().dialect);
  const migrationSources = collectMigrationSources(app);
  await runner.up(migrationSources);

  let queue: FakeQueueDriver | undefined;

  if (options.fakeQueue && app.has(QUEUE_TOKEN)) {
    // Hand the driver the app's JobRegistry so tests can assert by job
    // CLASS (`assertPushed(LogPostCreatedJob)`) rather than only by the
    // registered name string. See FakeQueueDriver's `JobIdentifier`.
    queue = new FakeQueueDriver(app.make<JobRegistry>(JOB_REGISTRY_TOKEN));
    app.make<QueueManager>(QUEUE_TOKEN).swap(queue);
  }

  let events: RecordingEventDispatcher | undefined;

  if (options.fakeEvents && app.has(EVENTS_TOKEN)) {
    events = new RecordingEventDispatcher(app);
    // Replace the container singleton so every fresh `make(EVENTS_TOKEN)`
    // (Model lifecycle events, the Events facade, etc.) resolves the
    // recorder. Listener wiring already ran during boot against the real
    // dispatcher; that's fine. A fake runs no listeners anyway.
    app.instance(EVENTS_TOKEN, events);
  }

  if (options.fakeHttp) {
    Http.fake();
  }

  let mail: RecordingMailManager | undefined;

  if (options.fakeMail && app.has(MAIL_TOKEN)) {
    mail = new RecordingMailManager(app, app.config.require<MailConfig>("mail"));
    // Replace the container singleton so `Mail.send()` (the facade
    // re-resolves MAIL_TOKEN on every call) and any freshly-injected
    // MailManager both hit the recorder.
    app.instance(MAIL_TOKEN, mail);
  }

  let notifications: RecordingChannelManager | undefined;

  if (options.fakeNotifications && app.has(NOTIFICATIONS_TOKEN)) {
    notifications = new RecordingChannelManager(app);
    app.instance(NOTIFICATIONS_TOKEN, notifications);
  }

  const storage: Record<string, FakeStorageDriver> = {};

  if (options.fakeStorage && app.has(STORAGE_TOKEN)) {
    const manager = app.make<StorageManager>(STORAGE_TOKEN);
    const disks = options.fakeStorage === true ? [manager.getDefaultDriver()] : options.fakeStorage;

    for (const disk of disks) {
      const diskDir = await mkdtemp(path.join(tmpdir(), `mahi-disk-${disk}-`));
      const fake = new FakeStorageDriver(diskDir);
      manager.swap(fake, disk);
      storage[disk] = fake;
    }
  }

  if (options.fakeCache && app.has(CACHE_TOKEN)) {
    // A fresh in-memory store with the sweep timer OFF. No interval to
    // keep the event loop alive after the test, and full per-test
    // isolation.
    app.make<CacheManager>(CACHE_TOKEN).swap(new ArrayCacheStore({ sweepIntervalSeconds: 0 }));
  }

  if (options.fakeProcess) {
    Process.fake();
  }

  const actingAs = (user: unknown, guard?: string): void => {
    if (!app.has(AUTH_TOKEN)) {
      throw new Error(
        "createTestApplication(): actingAs() requires @mahiframework/auth's AuthServiceProvider to be registered.",
      );
    }

    app.make<AuthManager>(AUTH_TOKEN).actingAs(user, guard);
  };

  // HTTP is optional: an app under test might register only the database/
  // queue layers. When no kernel is bound, `request()` throws a clear
  // error rather than failing at setup time.
  const hono = app.has(HTTP_KERNEL_TOKEN)
    ? app.make<HttpKernel>(HTTP_KERNEL_TOKEN).raw()
    : undefined;

  return {
    app,
    request: (p, init) => {
      if (!hono) {
        throw new Error(
          "createTestApplication(): no HTTP kernel is bound (HttpServiceProvider not registered), so request() is unavailable.",
        );
      }

      return Promise.resolve(hono.request(p, init));
    },
    cleanup: async () => {
      // Module-level fake state outlives the Application, so it has to be
      // torn down explicitly or it leaks into the next test file.
      if (options.fakeHttp) {
        Http.restore();
      }

      if (options.fakeProcess) {
        Process.restore();
      }

      // The acting-as override is process-global (see auth-context), so a
      // test that set one and threw before clearing it would authenticate
      // the next file's requests as a stale user. Always clear it.
      if (app.has(AUTH_TOKEN)) {
        app.make<AuthManager>(AUTH_TOKEN).actingAs(null);
      }

      // Terminate BEFORE releasing the database: this closes the sqlite
      // handle (and any Redis client the app opened), so the file is not
      // removed out from under an open connection, and the handle does
      // not linger holding the event loop open for the rest of the run.
      // On a server engine it also drains the pool, which Postgres
      // requires before the database can be dropped at all.
      await app.terminate();

      await dropScratchDatabase(database.engine, scratchDatabase);

      restoreEnv();
      await rm(tmpDir, { recursive: true, force: true });
      // Remove each fake disk's temp dir too.
      await Promise.all(
        Object.values(storage).map((disk) => rm(disk.rootPath(), { recursive: true, force: true })),
      );
    },
    resetDatabase: async () => {
      await runner.fresh(migrationSources);
    },
    clearDatabase: async () => {
      await db.schema().truncateAllTables();
    },
    queue,
    events,
    mail,
    notifications,
    storage,
    actingAs,
  };
}
