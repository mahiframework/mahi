import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Application, Collection, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import {
  BaseModel,
  DatabaseManager,
  DATABASE_TOKEN,
  MODEL_REGISTRY_TOKEN,
  Model,
  ModelNotFoundError,
  ModelRegistry,
  SqliteDriver,
} from "@mahiframework/database";
import { encodeModels, decodeModels } from "../src/model-serialization.js";
import { QueueManager } from "../src/queue-manager.js";
import { JobRegistry } from "../src/job-registry.js";
import { Job } from "../src/job.js";
import { SyncQueueDriver } from "../src/drivers/sync-queue-driver.js";
import { JOB_REGISTRY_TOKEN } from "../src/tokens.js";

interface UserAttributes {
  id: string;
  name: string;
}

class User extends Model<UserAttributes>()({
  table: "users",
  primaryKey: "id",
  timestamps: false,
  morphName: "User",
}) {}

/** A model that opts into skip-when-missing. */
class Ghost extends Model<UserAttributes>()({
  table: "ghosts",
  primaryKey: "id",
  timestamps: false,
  morphName: "Ghost",
  deleteWhenMissingModels: true,
}) {}

let app: Application;
let registry: ModelRegistry;

async function seedUser(id: string, name: string): Promise<User> {
  return User.create({ id, name });
}

beforeEach(async () => {
  app = new Application();
  const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
  manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
  app.instance(DATABASE_TOKEN, manager);

  registry = new ModelRegistry();
  registry.register(User);
  registry.register(Ghost);
  app.instance(MODEL_REGISTRY_TOKEN, registry);

  setCurrentApp(app);

  for (const table of ["users", "ghosts"]) {
    await manager
      .driver()
      .kysely.schema.createTable(table)
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();
  }
});

afterEach(() => clearCurrentApp());

describe("encodeModels", () => {
  it("replaces a single model instance with a { __model, __id } reference", async () => {
    const user = await seedUser("u1", "Ada");
    expect(encodeModels(user, registry)).toEqual({ __model: "User", __id: "u1" });
  });

  it("encodes models nested in plain objects and arrays", async () => {
    const a = await seedUser("u1", "Ada");
    const b = await seedUser("u2", "Bob");

    const encoded = encodeModels({ author: a, reviewers: [b], note: "hi" }, registry);

    expect(encoded).toEqual({
      author: { __model: "User", __id: "u1" },
      reviewers: [{ __model: "User", __id: "u2" }],
      note: "hi",
    });
  });

  it("encodes a Collection of models to an array of references", async () => {
    const a = await seedUser("u1", "Ada");
    const b = await seedUser("u2", "Bob");

    const encoded = encodeModels(Collection.make([a, b]), registry);
    expect(encoded).toEqual([
      { __model: "User", __id: "u1" },
      { __model: "User", __id: "u2" },
    ]);
  });

  it("leaves non-model data untouched", () => {
    const payload = { a: 1, b: "two", c: [true, null], d: { nested: 3 } };
    expect(encodeModels(payload, registry)).toEqual(payload);
  });

  it("throws when a model without a morphName appears in the payload", async () => {
    class Anon extends Model<UserAttributes>()({
      table: "anon",
      primaryKey: "id",
      timestamps: false,
    }) {}
    const anon = new (Anon as unknown as new (a: object) => BaseModel)({ id: "x", name: "n" });
    expect(() => encodeModels(anon, registry)).toThrow(/no static morphName/);
  });
});

/**
 * A job can carry a 64-bit id as plain data rather than as a model —
 * `new PublishJob(metaIds)` rather than `new PublishJob(metas)`. JSON
 * has no bigint, so without tagging this throws at dispatch, and
 * without restoring it `handle()` gets strings where it declared
 * `bigint[]` and every `whereIn("id", ids)` silently matches nothing.
 */
describe("bare bigints in a payload", () => {
  it("survives a JSON round trip as a bigint", async () => {
    const payload = { metaIds: [9007199254740993n, 2n], nested: { cursor: 42n }, name: "x" };
    const encoded = encodeModels(payload, registry);

    // The step that used to throw: what a durable driver does.
    const wire = JSON.parse(JSON.stringify(encoded));
    const decoded = (await decodeModels(wire, registry)) as typeof payload;

    expect(decoded.metaIds).toEqual([9007199254740993n, 2n]);
    expect(decoded.nested.cursor).toBe(42n);
    expect(decoded.name).toBe("x");
  });

  it("restores them even when the payload references no models at all", async () => {
    const encoded = encodeModels({ id: 7n }, registry);
    const decoded = (await decodeModels(JSON.parse(JSON.stringify(encoded)), registry)) as {
      id: bigint;
    };

    expect(decoded.id).toBe(7n);
  });
});

describe("decodeModels", () => {
  it("round-trips a single model back to a live instance", async () => {
    const user = await seedUser("u1", "Ada");
    const encoded = encodeModels(user, registry);

    const decoded = (await decodeModels(encoded, registry)) as User;
    expect(decoded).toBeInstanceOf(BaseModel);
    expect((decoded as User).id).toBe("u1");
    expect((decoded as User).name).toBe("Ada");
  });

  it("round-trips nested + array structures", async () => {
    await seedUser("u1", "Ada");
    await seedUser("u2", "Bob");

    const encoded = {
      author: { __model: "User", __id: "u1" },
      reviewers: [{ __model: "User", __id: "u2" }],
      note: "hi",
    };
    const decoded = (await decodeModels(encoded, registry)) as {
      author: User;
      reviewers: User[];
      note: string;
    };

    expect(decoded.author.name).toBe("Ada");
    expect(decoded.reviewers[0]!.name).toBe("Bob");
    expect(decoded.note).toBe("hi");
  });

  it("batches lookups per model type (no N+1)", async () => {
    await seedUser("u1", "Ada");
    await seedUser("u2", "Bob");
    const spy = vi.spyOn(User, "findMany");

    const encoded = [
      { __model: "User", __id: "u1" },
      { __model: "User", __id: "u2" },
    ];
    await decodeModels(encoded, registry);

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("throws ModelNotFoundError when a referenced row is gone (default)", async () => {
    const encoded = { __model: "User", __id: "missing" };
    await expect(decodeModels(encoded, registry)).rejects.toBeInstanceOf(ModelNotFoundError);
  });

  it("throws the skip signal when a deleteWhenMissingModels model is gone", async () => {
    const encoded = { __model: "Ghost", __id: "missing" };
    await expect(decodeModels(encoded, registry)).rejects.toThrow(/no longer/);
  });
});

describe("end-to-end via SyncQueueDriver", () => {
  // Carries whatever is handed to it as an own field, so its serialization
  // exercises the model encode/decode round-trip on a job instance.
  class RecordJob extends Job {
    constructor(public readonly data: unknown) {
      super();
    }
    handle(): void {
      RecordJob.received.push(this.data);
    }
    static received: unknown[] = [];
  }

  function wireQueue(): { manager: QueueManager; received: unknown[] } {
    RecordJob.received = [];
    const jobRegistry = new JobRegistry();
    jobRegistry.register("record", RecordJob);
    app.instance(JOB_REGISTRY_TOKEN, jobRegistry);

    const manager = new QueueManager(app, { default: "sync", connections: { sync: {} } });
    manager.extend("sync", () => new SyncQueueDriver(app, jobRegistry));

    return { manager, received: RecordJob.received };
  }

  it("rehydrates a model in the job's fields before handle() runs", async () => {
    await seedUser("u1", "Ada");
    const user = (await User.find("u1")) as User;
    const { manager, received } = wireQueue();

    await manager.dispatch(new RecordJob({ user }));

    const data = received[0] as { user: User };
    expect(data.user).toBeInstanceOf(BaseModel);
    expect(data.user.id).toBe("u1");
    expect(data.user.name).toBe("Ada");
  });

  it("skips the job (no handle, no throw) when a deleteWhenMissingModels model is gone", async () => {
    const { manager, received } = wireQueue();
    // A job field holding a raw reference to a Ghost that was never inserted,
    // encodeModels passes the reference through untouched, decode looks it up.
    const job = new RecordJob({ ghost: { __model: "Ghost", __id: "nope" } });

    await expect(manager.dispatch(job)).resolves.toBe(true);
    expect(received).toHaveLength(0);
  });

  it("fails the job (throws to caller) when a default model is gone", async () => {
    const { manager } = wireQueue();
    const job = new RecordJob({ user: { __model: "User", __id: "nope" } });
    await expect(manager.dispatch(job)).rejects.toBeInstanceOf(ModelNotFoundError);
  });
});
