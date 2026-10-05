import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Application,
  EVENTS_TOKEN,
  STORAGE_TOKEN,
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
} from "@mahiframework/database";
import { EventDispatcher } from "@mahiframework/events";
import { FakeStorageDriver, StorageManager } from "@mahiframework/storage";
import { SnowflakeServiceProvider } from "@mahiframework/snowflake";
import { belongsToMedia } from "../../src/builders/belongs-to-media.js";
import { hasManyMedia } from "../../src/builders/has-many-media.js";
import { hasOneMedia } from "../../src/builders/has-one-media.js";
import { MediaServiceProvider } from "../../src/media-service-provider.js";
import { MediaManager } from "../../src/media-manager.js";
import { FakeImageDriver } from "../../src/image/fake-image-driver.js";
import { ImageManager } from "../../src/image/image-manager.js";
import { IMAGE_TOKEN, MEDIA_TOKEN } from "../../src/tokens.js";
import type { MediaConfig } from "../../src/media-config.js";
import createMediaTable from "../../src/migrations/0001_create_media_table.js";

/**
 * A snowflake-keyed owner, which is the common case and what
 * `create-mahi`'s template `User` is.
 *
 * Ids are assigned by hand rather than via `keyType: snowflake()`:
 * `MediaFile` needs the snowflake provider for its own key and the
 * harness registers it, but the owner's key is incidental to every test
 * here and sequential literals make a failure message readable.
 */
export interface UserAttributes {
  id: bigint;
  email: string;
  avatar_id: bigint | null;
}

export class User extends Model<UserAttributes>()({
  table: "users",
  primaryKey: "id",
  morphName: "User",
  timestamps: false,
}) {
  /**
   * The documented shape: a METHOD returning a configured builder.
   *
   * Not a field. `Model.hydrate()` assigns attributes after calling the
   * constructor, and a field also depends on `useDefineForClassFields`
   * being true — under assignment semantics it would hit the model
   * proxy's `set` trap and become a dirty-tracked attribute.
   */
  avatar() {
    return belongsToMedia(this, "avatar_id").accept({ mimes: ["image/*"] });
  }

  photos() {
    return hasManyMedia(this).collection("photos");
  }

  documents() {
    return hasManyMedia(this).collection("documents");
  }
}

/**
 * A UUID-keyed owner.
 *
 * Not a nicety. `media.model_id` is TEXT precisely so that any key type
 * can own media, which is the one place this schema deliberately
 * diverges from `permissions` (whose `bigInteger model_id` makes
 * snowflake-keyed assignees a hard limit). A test suite with only
 * `bigint` owners would let that column silently regress to
 * `unsignedBigInteger` — which is what `nullableMorphs()` would have
 * given it.
 */
export interface TenantAttributes {
  id: string;
  name: string;
}

export class Tenant extends Model<TenantAttributes>()({
  table: "tenants",
  primaryKey: "id",
  morphName: "Tenant",
  timestamps: false,
}) {
  logo() {
    return hasOneMedia(this).collection("logo");
  }

  /** A string-keyed owner holding many files, for the text model_id. */
  attachments() {
    return hasManyMedia(this).collection("attachments");
  }
}

export interface Harness {
  app: Application;
  media: MediaManager;
  provider: MediaServiceProvider;
  events: EventDispatcher;
  storage: StorageManager;
  images: ImageManager;
  /** Registered under `"fake"`; only resolved when a test configures it. */
  imageDriver: FakeImageDriver;
  /** The private disk, which is the default. */
  disk: FakeStorageDriver;
  /** A disk with a `url` prefix configured, i.e. a "public" disk. */
  publicDisk: FakeStorageDriver;
  cleanup: () => Promise<void>;
}

/**
 * An application with the real provider registered against in-memory
 * SQLite and two temp-backed fake disks.
 *
 * Framework-package style, no `@mahiframework/testing` dependency.
 *
 * Runs the real migration file rather than hand-rolled schema, so drift
 * between what the migration creates and what the model queries shows up
 * as a failure here instead of only in a real app.
 *
 * Two disks, because "is this disk public" is a question this package
 * answers from storage config and must get right in both directions: a
 * `url` prefix makes `url()` work, its absence makes `url()` throw.
 *
 * `SnowflakeServiceProvider` is registered rather than stubbed because
 * `MediaFile` declares `keyType: snowflake()`, which resolves
 * `SNOWFLAKE_TOKEN` at generate time — so the provider is a hard runtime
 * requirement of the package, not harness convenience, and a suite that
 * faked the ids would hide that. `testing: true` makes them sequential so
 * a failure message names a readable id.
 */
export async function createHarness(config: MediaConfig = {}): Promise<Harness> {
  const app = new Application();

  const database = new DatabaseManager(app, { default: "sqlite", connections: {} });
  database.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
  app.instance(DATABASE_TOKEN, database);
  app.bind(SCHEMA_TOKEN, () => database.schema());

  const root = await mkdtemp(join(tmpdir(), "mahi-media-"));
  const disk = new FakeStorageDriver(join(root, "private"));
  const publicDisk = new FakeStorageDriver(join(root, "public"), "/storage");

  // Created up front so `allFiles()` on an untouched disk returns `[]`
  // rather than failing to `realpath` a directory the driver only makes
  // on first write. A test asserting "nothing was written" needs the
  // empty case to be readable.
  await mkdir(join(root, "private"), { recursive: true });
  await mkdir(join(root, "public"), { recursive: true });

  const storage = new StorageManager(app, {
    default: "local",
    disks: {
      local: { root: join(root, "private") },
      public: { root: join(root, "public"), url: "/storage" },
    },
  });
  storage.extend("local", () => disk);
  storage.extend("public", () => publicDisk);
  app.instance(STORAGE_TOKEN, storage);

  // A real dispatcher, not a recorder: the model fires its events
  // through `dispatchesEvents`, so a wrong event class or a missing
  // registration should fail here rather than in an app.
  const events = new EventDispatcher(app);
  app.instance(EVENTS_TOKEN, events);

  setCurrentApp(app);

  app.config.set("snowflake", {
    testing: true,
    sequencing: { resolver: null, prefix: "" },
    constants: { epoch: "2025-01-01 00:00:00", cluster: 1, worker: 1 },
  });
  new SnowflakeServiceProvider(app).register();

  app.config.set("media", config);

  const provider = new MediaServiceProvider(app);
  provider.register();

  // Registered but not configured by default: an app that stores only
  // documents needs no image driver, and the tests for that path depend
  // on `media.image.default` being unset. A test that wants modifiers
  // passes `{ image: { default: "fake" } }`.
  const images = app.make<ImageManager>(IMAGE_TOKEN);
  const imageDriver = new FakeImageDriver();
  images.extend("fake", () => imageDriver);

  await createMediaTable.up();

  // The app-owned tables. Hand-stubbed because `users` is the app's, not
  // the framework's, and this package ships no migration for it.
  await Schema.create("users", (table) => {
    table.bigInteger("id").primary();
    table.string("email");
    table.bigInteger("avatar_id").nullable();
  });

  await Schema.create("tenants", (table) => {
    table.string("id").primary();
    table.string("name");
  });

  return {
    app,
    media: app.make<MediaManager>(MEDIA_TOKEN),
    provider,
    events,
    storage,
    images,
    imageDriver,
    disk,
    publicDisk,
    cleanup: async () => {
      // The morph map is process-global, not container-bound, so a test
      // that registered one would leak into the next file.
      Relation.resetMorphMap();
      clearCurrentApp();
      await rm(root, { recursive: true, force: true });
    },
  };
}

let nextKey = 1n;

/** A user with a unique snowflake-shaped key. */
export async function makeUser(email = `user${nextKey}@example.com`): Promise<User> {
  const id = 9_000_000_000_000_000_000n + nextKey++;

  return (await User.create({ id, email, avatar_id: null })) as User;
}

/** A UUID-keyed tenant, for the non-bigint owner case. */
export async function makeTenant(name = `tenant${nextKey}`): Promise<Tenant> {
  const id = `11111111-1111-4111-8111-${String(nextKey++).padStart(12, "0")}`;

  return (await Tenant.create({ id, name })) as Tenant;
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
