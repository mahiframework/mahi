import {
  Application,
  CACHE_TOKEN,
  EVENTS_TOKEN,
  QUEUE_TOKEN,
  clearCurrentApp,
  setCurrentApp,
} from "@mahiframework/core";
import {
  DATABASE_TOKEN,
  DatabaseManager,
  SCHEMA_TOKEN,
  SqliteDriver,
} from "@mahiframework/database";
import { ArrayCacheStore, CacheManager, type CacheStore } from "@mahiframework/cache";
import { EventDispatcher } from "@mahiframework/events";
import { JobRegistry, QueueManager, SyncQueueDriver } from "@mahiframework/queue";
import { JOB_REGISTRY_TOKEN } from "@mahiframework/queue";
import createWatchtowerTables from "../../src/migrations/0001_create_watchtower_tables.js";
import createWatchtowerJobsTable from "../../src/migrations/0002_create_watchtower_jobs_table.js";

export interface Harness {
  app: Application;
  database: DatabaseManager;
  cache: CacheManager;
  store: CacheStore;
  events: EventDispatcher;
  queue: QueueManager;
  registry: JobRegistry;
  cleanup: () => void;
}

export interface HarnessOptions {
  /** Run the two migrations. On by default. */
  migrate?: boolean;
}

/**
 * An application against in-memory SQLite, with the real migrations.
 *
 * Framework-package style: no `@mahiframework/testing` dependency.
 *
 * The migrations are the real files rather than hand-rolled schema, so
 * drift between what a migration creates and what the driver queries
 * fails here instead of only in a real app.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const app = new Application();

  const database = new DatabaseManager(app, { default: "sqlite", connections: {} });
  database.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
  app.instance(DATABASE_TOKEN, database);
  app.bind(SCHEMA_TOKEN, () => database.schema());

  const cache = new CacheManager(app, { default: "array", stores: {} });
  // `sweepIntervalSeconds: 0` so no timer is started: a sweeper firing
  // mid-assertion could expire a deferral key a test is about to read.
  cache.extend("array", () => new ArrayCacheStore({ sweepIntervalSeconds: 0 }));
  app.instance(CACHE_TOKEN, cache);

  const events = new EventDispatcher(app);
  app.instance(EVENTS_TOKEN, events);

  const jobRegistry = new JobRegistry();
  app.instance(JOB_REGISTRY_TOKEN, jobRegistry);

  const queue = new QueueManager(app, { default: "sync", connections: {} });
  queue.extend("sync", () => new SyncQueueDriver(app, jobRegistry));
  app.instance(QUEUE_TOKEN, queue);

  setCurrentApp(app);

  if (options.migrate !== false) {
    await createWatchtowerTables.up();
    await createWatchtowerJobsTable.up();
  }

  return {
    app,
    database,
    cache,
    store: cache.store(),
    events,
    queue,
    registry: jobRegistry,
    cleanup: () => {
      clearCurrentApp();
    },
  };
}

/**
 * Await a promise and return whatever it threw.
 *
 * `promise.catch((e) => e)` types as `T | unknown` and forces a cast at
 * every call site; this narrows to the error.
 */
export async function captureError<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("Expected the promise to reject, but it resolved.");
}
