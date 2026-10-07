import {
  Application,
  CACHE_TOKEN,
  EVENTS_TOKEN,
  clearCurrentApp,
  setCurrentApp,
} from "@mahiframework/core";
import {
  DATABASE_TOKEN,
  DatabaseManager,
  Model,
  Relation,
  SCHEMA_TOKEN,
  Schema,
  SqliteDriver,
  type MorphToMany,
} from "@mahiframework/database";
import { ArrayCacheStore, CacheManager, type CacheStore } from "@mahiframework/cache";
import { EventDispatcher } from "@mahiframework/events";
import { PermissionsServiceProvider } from "../../src/permissions-service-provider.js";
import { PermissionRegistrar } from "../../src/permission-registrar.js";
import { PERMISSIONS_TOKEN } from "../../src/tokens.js";
import type { PermissionsConfig } from "../../src/permissions-config.js";
import { permissionsRelation, rolesRelation } from "../../src/relations.js";
import type { Permission } from "../../src/models/permission.model.js";
import type { Role } from "../../src/models/role.model.js";
import createPermissionTables from "../../src/migrations/0001_create_permission_tables.js";

/**
 * An integer-keyed user, which is what the pivots require: `model_id` is
 * a `bigInteger`, so the key has to be a `bigint`. Ids are assigned by
 * hand here rather than left to the database, so a failure message names
 * a predictable id.
 */
export interface UserAttributes {
  id: bigint;
  email: string;
  roles: MorphToMany<Role>;
  permissions: MorphToMany<Permission>;
}

export class User extends Model<UserAttributes>()({
  table: "users",
  primaryKey: "id",
  morphName: "User",
  timestamps: false,
}) {
  static override relationships = {
    roles: rolesRelation(),
    permissions: permissionsRelation(),
  };
}

/**
 * A second assignable model, so "two models in one app" is exercised
 * rather than assumed. `model_has_roles` discriminates on `model_type`,
 * and a `Team` with the same numeric id as a `User` must not inherit its
 * roles.
 */
export interface TeamAttributes {
  id: bigint;
  name: string;
}

export class Team extends Model<TeamAttributes>()({
  table: "teams",
  primaryKey: "id",
  morphName: "Team",
  timestamps: false,
}) {}

/** A model that keys on a string, for the unsupported-key path. */
export interface LegacyAccountAttributes {
  id: string;
  name: string;
}

export class LegacyAccount extends Model<LegacyAccountAttributes>()({
  table: "legacy_accounts",
  primaryKey: "id",
  morphName: "LegacyAccount",
  timestamps: false,
}) {}

export interface Harness {
  app: Application;
  events: EventDispatcher;
  registrar: PermissionRegistrar;
  provider: PermissionsServiceProvider;
  store: CacheStore;
  cleanup: () => void;
}

/**
 * An application with the real provider registered against in-memory
 * SQLite.
 *
 * Framework-package style, no `@mahiframework/testing` dependency.
 *
 * Runs the real migration file rather than hand-rolled schema, so drift
 * between what the migration creates and what the registrar queries
 * shows up as a failure here instead of only in a real app. That also
 * means the `cascadeOnDelete` foreign keys are genuinely under test:
 * `SqliteDriver` sets `PRAGMA foreign_keys = ON`.
 *
 * Wires the provider's `listeners()` into a real `EventDispatcher` by
 * hand, rather than stubbing the listener, so a wrong event class or a
 * missing hook fails here.
 *
 * `auth` is deliberately NOT bound. The registrar falls back to
 * `auth.default` only when `AUTH_TOKEN` exists, so every test resolves
 * its guard from config — which keeps the guard explicit in the tests
 * that care about it and absent from the ones that don't.
 */
export async function createHarness(config: PermissionsConfig = {}): Promise<Harness> {
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
  app.instance(EVENTS_TOKEN, events);
  setCurrentApp(app);

  app.config.set("permissions", { guard: "web", ...config });

  const provider = new PermissionsServiceProvider(app);
  provider.register();

  for (const [eventClass, listener] of provider.listeners()) {
    events.listen(eventClass as never, listener as never);
  }

  await createPermissionTables.up();

  // The app-owned tables. Hand-stubbed because `users` is the app's, not
  // the framework's, and this package ships no migration for it.
  await Schema.create("users", (table) => {
    table.bigInteger("id").primary();
    table.string("email");
  });

  await Schema.create("teams", (table) => {
    table.bigInteger("id").primary();
    table.string("name");
  });

  await Schema.create("legacy_accounts", (table) => {
    table.string("id").primary();
    table.string("name");
  });

  return {
    app,
    events,
    provider,
    registrar: app.make<PermissionRegistrar>(PERMISSIONS_TOKEN),
    store: cache.store(),
    cleanup: () => {
      // The morph map is process-global, not container-bound, so a test
      // that registered one would leak into the next file.
      Relation.resetMorphMap();
      clearCurrentApp();
    },
  };
}

let nextKey = 1n;

/** A user with a unique integer key. */
export async function makeUser(email = `user${nextKey}@example.com`): Promise<User> {
  const id = 9_000_000_000_000_000_000n + nextKey++;

  return (await User.create({ id, email })) as User;
}

/** A team, for the two-models-one-id case. */
export async function makeTeam(name = `team${nextKey}`): Promise<Team> {
  const id = 9_000_000_000_000_000_000n + nextKey++;

  return (await Team.create({ id, name })) as Team;
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
