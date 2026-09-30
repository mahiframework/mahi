import { afterEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import {
  DATABASE_TOKEN,
  DatabaseManager,
  MigrationRunner,
  Model,
  Relation,
  SCHEMA_TOKEN,
  SqliteDriver,
  transaction,
} from "@mahiframework/database";
import { DatabaseChannel } from "../src/channels/database-channel.js";
import { Notification } from "../src/notification.js";
import type { NotificationRoutable } from "../src/notifiable.js";

/**
 * The plain-adapter notifiable the guide documents, implements
 * `NotificationRoutable` without extending `Model`, so it has no
 * `morphAlias()` and falls back to its static `table`.
 */
class User implements NotificationRoutable {
  static table = "users";
  constructor(public id: string) {}
  routeNotificationFor(channel: string): unknown {
    return channel === "database" ? this.id : null;
  }
}

interface UserModelAttributes {
  id: string;
}

/** A notifiable that IS a real `Model`, so `morphAlias()` names it. */
class UserModel
  extends Model<UserModelAttributes>()({
    table: "users",
    primaryKey: "id",
    morphName: "User",
    timestamps: false,
  })
  implements NotificationRoutable
{
  routeNotificationFor(channel: string): unknown {
    return channel === "database" ? this.getRawAttribute("id") : null;
  }
}

interface TeamAttributes {
  id: string;
}

/** A `Model` notifiable with no `morphName`, so the alias falls through to `table`. */
class Team
  extends Model<TeamAttributes>()({
    table: "teams",
    primaryKey: "id",
    timestamps: false,
  })
  implements NotificationRoutable
{
  routeNotificationFor(channel: string): unknown {
    return channel === "database" ? this.getRawAttribute("id") : null;
  }
}

/** A notifiable with neither `morphAlias()` nor a static `table`. */
class Anonymous implements NotificationRoutable {
  routeNotificationFor(): unknown {
    return "x";
  }
}

class FollowNotification extends Notification {
  constructor(private actorId: string) {
    super();
  }
  via(): string[] {
    return ["database"];
  }
  toDatabase(): Record<string, unknown> {
    return { actorId: this.actorId };
  }
}

class SilentNotification extends Notification {
  via(): string[] {
    return ["database"];
  }
}

async function buildChannel() {
  const sqlite = new SqliteDriver({ filename: ":memory:" });

  const app = new Application();
  const manager = new DatabaseManager(app, { default: "sqlite", connections: { sqlite: {} } });
  manager.extend("sqlite", () => sqlite);
  app.instance(DATABASE_TOKEN, manager);
  app.bind(SCHEMA_TOKEN, () => manager.schema());
  setCurrentApp(app);

  const runner = new MigrationRunner(sqlite.kysely);
  await runner.up([new URL("../src/migrations", import.meta.url).pathname]);

  return { channel: new DatabaseChannel(manager), kysely: sqlite.kysely };
}

describe("DatabaseChannel", () => {
  afterEach(() => {
    clearCurrentApp();
    Relation.resetMorphMap();
  });

  it("inserts a row with the polymorphic notifiable columns and JSON data", async () => {
    const { channel, kysely } = await buildChannel();

    await channel.send(new User("user-1"), new FollowNotification("actor-9"));

    const rows = await kysely.selectFrom("notifications").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "FollowNotification",
      notifiable_type: "users",
      notifiable_id: "user-1",
      read_at: null,
    });
    expect(JSON.parse(rows[0]!.data as string)).toEqual({ actorId: "actor-9" });
    expect(rows[0]!.id).toBeTruthy();
    expect(rows[0]!.created_at).toBeTruthy();
  });

  it("uses the notification's explicit id when set", async () => {
    const { channel, kysely } = await buildChannel();

    const notification = new FollowNotification("actor-9");
    notification.id = "fixed-id";
    await channel.send(new User("user-1"), notification);

    const rows = await kysely.selectFrom("notifications").selectAll().execute();
    expect(rows[0]!.id).toBe("fixed-id");
  });

  it("is a no-op when the notification does not implement toDatabase", async () => {
    const { channel, kysely } = await buildChannel();

    await channel.send(new User("user-1"), new SilentNotification());

    const rows = await kysely.selectFrom("notifications").selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it("throws when the notifiable has neither morphAlias() nor a static table", async () => {
    const { channel } = await buildChannel();

    await expect(channel.send(new Anonymous(), new FollowNotification("actor-9"))).rejects.toThrow(
      /`morphAlias\(\)`.*or a static `table`/s,
    );
  });

  describe("notifiable_type resolution", () => {
    it("uses morphAlias() when the notifiable is a real Model", async () => {
      const { channel, kysely } = await buildChannel();

      // A live Model is Proxy-wrapped and its `get` trap binds
      // `constructor`, stripping the statics, so reading
      // `instance.constructor.table` yields undefined. The class must be
      // read off the prototype.
      await channel.send(UserModel.hydrate({ id: "u1" }) as any, new FollowNotification("actor-9"));

      const rows = await kysely.selectFrom("notifications").selectAll().execute();
      expect(rows[0]).toMatchObject({ notifiable_type: "User", notifiable_id: "u1" });
    });

    it("falls through to the table name for a Model with no morphName", async () => {
      const { channel, kysely } = await buildChannel();

      await channel.send(Team.hydrate({ id: "t1" }) as any, new FollowNotification("actor-9"));

      const rows = await kysely.selectFrom("notifications").selectAll().execute();
      expect(rows[0]).toMatchObject({ notifiable_type: "teams" });
    });

    it("honours a registered morph map, so the alias is configurable", async () => {
      const { channel, kysely } = await buildChannel();
      Relation.morphMap({ users: () => UserModel });

      await channel.send(UserModel.hydrate({ id: "u1" }) as any, new FollowNotification("actor-9"));

      // A morph map entry controls what is written: mapping UserModel to
      // "users" stores the alias rather than the class name.
      const rows = await kysely.selectFrom("notifications").selectAll().execute();
      expect(rows[0]).toMatchObject({ notifiable_type: "users" });
    });

    it("still supports plain adapter notifiables via static table", async () => {
      const { channel, kysely } = await buildChannel();

      await channel.send(new User("user-1"), new FollowNotification("actor-9"));

      const rows = await kysely.selectFrom("notifications").selectAll().execute();
      expect(rows[0]).toMatchObject({ notifiable_type: "users" });
    });

    it("propagates a morph-map violation rather than silently writing a table name", async () => {
      const { channel } = await buildChannel();
      Relation.requireMorphMap();

      await expect(
        channel.send(UserModel.hydrate({ id: "u1" }) as any, new FollowNotification("actor-9")),
      ).rejects.toThrow(/No morph alias is registered/);
    });

    it("writes the same discriminant a morphMany against the table would", async () => {
      const { channel, kysely } = await buildChannel();
      Relation.morphMap({ user: () => UserModel });

      await channel.send(UserModel.hydrate({ id: "u1" }) as any, new FollowNotification("actor-9"));

      const rows = await kysely.selectFrom("notifications").selectAll().execute();
      // The agreement that makes a `notifiable` morphTo resolvable.
      expect(rows[0]!.notifiable_type).toBe(UserModel.morphAlias());
    });
  });

  describe("transaction participation", () => {
    it("writes on the active transaction, so a rollback takes the row with it", async () => {
      const { channel, kysely } = await buildChannel();

      // Writing to the root connection instead would commit the
      // notification independently of the transaction that produced it,
      // leaving a row pointing at a record that no longer exists.
      await expect(
        transaction(kysely, async () => {
          await channel.send(new User("user-1"), new FollowNotification("actor-9"));
          throw new Error("rolled back");
        }),
      ).rejects.toThrow("rolled back");

      const rows = await kysely.selectFrom("notifications").selectAll().execute();
      expect(rows).toHaveLength(0);
    });

    it("commits with the transaction when it succeeds", async () => {
      const { channel, kysely } = await buildChannel();

      await transaction(kysely, async () => {
        await channel.send(new User("user-1"), new FollowNotification("actor-9"));
      });

      const rows = await kysely.selectFrom("notifications").selectAll().execute();
      expect(rows).toHaveLength(1);
    });
  });
});
