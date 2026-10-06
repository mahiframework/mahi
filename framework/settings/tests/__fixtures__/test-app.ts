import {
  Application,
  CACHE_TOKEN,
  EVENTS_TOKEN,
  ServiceProvider,
  clearCurrentApp,
  setCurrentApp,
} from "@mahiframework/core";
import {
  DATABASE_TOKEN,
  DatabaseManager,
  Model,
  SCHEMA_TOKEN,
  SqliteDriver,
} from "@mahiframework/database";
import { ArrayCacheStore, CacheManager, type CacheStore } from "@mahiframework/cache";
import { EventDispatcher } from "@mahiframework/events";
import { Rule } from "@mahiframework/validation";
import createSettingsTable from "../../src/migrations/0001_create_settings_table.js";
import type { SettingDefinition } from "../../src/setting-definition.js";
import type { SettingsConfig } from "../../src/settings-config.js";
import { SettingsRegistry } from "../../src/settings-registry.js";
import { SettingsServiceProvider } from "../../src/settings-service-provider.js";
import { SETTINGS_TOKEN } from "../../src/tokens.js";

/**
 * A user for the actor tests.
 *
 * `timestamps: false` and ids assigned by hand: `edited_by_user_id` is
 * TEXT and the registry stringifies whatever key it is handed, so the
 * key type here is deliberately a plain `bigint` rather than a real
 * `snowflake()` — which would need the snowflake provider booted to no
 * purpose.
 */
export interface UserAttributes {
  id: bigint;
  email: string;
}

export class User extends Model<UserAttributes>()({
  table: "users",
  primaryKey: "id",
  morphName: "User",
  timestamps: false,
}) {}

/**
 * One definition per `SettingType`, plus the cases that are easy to get
 * wrong.
 *
 * Shared rather than per-test so the suites agree on what "the string
 * setting" is, and so a type added to `SettingType` without a decoder
 * fails somewhere here.
 */
export function testDefinitions(): SettingDefinition[] {
  return [
    {
      name: "app_name",
      category: "general",
      description: "The application's display name.",
      type: "string",
      defaultValue: () => "Mahi",
    },
    {
      name: "import_batch_size",
      category: "import",
      type: "number",
      rules: () => Rule.make().min(1).max(1000),
      defaultValue: () => 100,
    },
    {
      name: "import_feature_enabled",
      category: "import",
      type: "boolean",
      defaultValue: () => false,
    },
    {
      name: "maintenance_until",
      type: "datetime",
      defaultValue: () => null,
    },
    {
      name: "allowed_domains",
      type: "array",
      defaultValue: () => [],
    },
    {
      name: "branding",
      type: "json",
      // An object default, which is the case the thunk exists for: a
      // shared reference would let one caller's mutation become
      // everybody's default.
      defaultValue: () => ({ primary: "#000000" }),
    },
  ];
}

/** A provider that declares whatever it is given, for the hook tests. */
export function definingProvider(
  definitions: SettingDefinition[],
): new (app: Application) => ServiceProvider {
  return class extends ServiceProvider {
    settings(): SettingDefinition[] {
      return definitions;
    }
  };
}

export interface Harness {
  app: Application;
  events: EventDispatcher;
  registry: SettingsRegistry;
  provider: SettingsServiceProvider;
  store: CacheStore;
  cleanup: () => void;
}

export interface HarnessOptions {
  config?: SettingsConfig;
  /** Declared through a provider, so the `settings()` hook is what is under test. */
  definitions?: SettingDefinition[];
  /** Bind an `EventDispatcher`. Off for the "events not installed" path. */
  events?: boolean;
}

/**
 * An application with the real provider registered against in-memory
 * SQLite.
 *
 * Framework-package style, no `@mahiframework/testing` dependency.
 *
 * Runs the real migration file rather than hand-rolled schema, so drift
 * between what the migration creates and what the registry queries shows
 * up as a failure here instead of only in a real app.
 *
 * Definitions arrive through a registered provider's `settings()` hook
 * and are collected by the real `boot()`, rather than being pushed into
 * the registry directly — so the collection path is under test in every
 * suite rather than in one.
 *
 * `auth` is deliberately NOT bound and no auth scope is opened. The
 * registry reads `currentAuthState()`, which returns `undefined` outside
 * a scope, so every write defaults to a null actor — which is exactly
 * the CLI/queue-worker case, and the one that must not throw. The actor
 * tests opt into a scope with `runWithAuth()`.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const app = new Application();
  const database = new DatabaseManager(app, { default: "sqlite", connections: {} });
  database.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
  app.instance(DATABASE_TOKEN, database);
  app.bind(SCHEMA_TOKEN, () => database.schema());

  const cache = new CacheManager(app, { default: "array", stores: {} });
  // `sweepIntervalSeconds: 0` so no timer is started at all. The store's
  // own timer is `unref()`ed and so would not hang the suite, but a
  // sweeper firing mid-assertion could expire an entry a test is about
  // to read.
  cache.extend("array", () => new ArrayCacheStore({ sweepIntervalSeconds: 0 }));
  app.instance(CACHE_TOKEN, cache);

  const events = new EventDispatcher(app);

  if (options.events !== false) {
    app.instance(EVENTS_TOKEN, events);
  }

  setCurrentApp(app);

  app.config.set("settings", { ...options.config });

  // Both providers go through the real `register()`/`boot()` lifecycle
  // rather than being constructed by hand. `app.register()` only QUEUES a
  // class — providers are instantiated during `bootstrap()`, and
  // `getProviders()` is empty until then — so constructing
  // `SettingsServiceProvider` directly would leave it walking an empty
  // list and the `settings()` hook would never be exercised.
  //
  // The defining provider is registered FIRST deliberately: the
  // collection must not depend on declaration order, and the suite also
  // covers the reverse.
  app.register(definingProvider(options.definitions ?? testDefinitions()));
  app.register(SettingsServiceProvider);
  await app.bootstrap();

  const provider = app
    .getProviders()
    .find(
      (candidate): candidate is SettingsServiceProvider =>
        candidate instanceof SettingsServiceProvider,
    )!;

  // By hand, because `EventsServiceProvider` is not registered here —
  // so a wrong event class or a missing hook fails in this file rather
  // than silently never firing.
  for (const [eventClass, listener] of provider.listeners()) {
    events.listen(eventClass as never, listener as never);
  }

  await createSettingsTable.up();

  // App-owned, hand-stubbed: this package ships no migration for `users`.
  await app
    .make<DatabaseManager>(DATABASE_TOKEN)
    .schema()
    .create("users", (table) => {
      table.bigInteger("id").primary();
      table.string("email");
    });

  return {
    app,
    events,
    provider,
    registry: app.make<SettingsRegistry>(SETTINGS_TOKEN),
    store: cache.store(),
    cleanup: () => {
      clearCurrentApp();
    },
  };
}

let nextKey = 1n;

/** A user, for the `edited_by_user_id` tests. */
export async function makeUser(email = `user${nextKey}@example.com`): Promise<User> {
  const id = 9_000_000_000_000_000_000n + nextKey++;

  return (await User.create({ id, email })) as User;
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
