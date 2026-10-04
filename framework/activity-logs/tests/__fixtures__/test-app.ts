import { Application, EVENTS_TOKEN, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import {
  Cast,
  DATABASE_TOKEN,
  DatabaseManager,
  Model,
  SCHEMA_TOKEN,
  Schema,
  SqliteDriver,
} from "@mahiframework/database";
import { EventDispatcher } from "@mahiframework/events";
import { ActivityLogServiceProvider } from "../../src/activity-log-service-provider.js";
import { ActivityLogger } from "../../src/activity-logger.js";
import { ACTIVITY_LOG_TOKEN } from "../../src/tokens.js";
import type { ActivityLogConfig } from "../../src/activity-log-config.js";
import createActivityLogsTable from "../../src/migrations/0001_create_activity_logs_table.js";

export interface PostAttributes {
  id: string;
  title: string;
  body: string;
  secret_note: string | null;
  settings: Record<string, unknown> | null;
  deleted_at: string | null;
}

/** A soft-deleting model with one hidden column and one JSON column. */
export class Post extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
  morphName: "Post",
  timestamps: false,
  softDeletes: true,
  hidden: ["secret_note"],
  casts: { settings: Cast.json<Record<string, unknown>>() },
}) {}

export interface WidgetAttributes {
  id: string;
  name: string;
  internal: string;
}

/** A hard-deleting model, for the delete-vs-soft-delete split. */
export class Widget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  morphName: "Widget",
  timestamps: false,
}) {}

export interface UserAttributes {
  id: string;
  email: string;
  password: string;
}

export class User extends Model<UserAttributes>()({
  table: "users",
  primaryKey: "id",
  morphName: "User",
  timestamps: false,
  hidden: ["password"],
}) {}

export interface Harness {
  app: Application;
  events: EventDispatcher;
  logger: ActivityLogger;
  /** Every activity row, oldest first. */
  rows(): Promise<RowShape[]>;
  cleanup(): void;
}

export interface RowShape {
  type: string;
  action: string | null;
  model_type: string;
  model_id: string;
  user_id: string | null;
  message: string | null;
  data: Record<string, unknown> | null;
}

/**
 * An application with the real provider registered against in-memory
 * SQLite.
 *
 * Registers `ActivityLogServiceProvider` and wires its `listeners()`
 * into a real `EventDispatcher` by hand, rather than stubbing the
 * listener. That is the point: the test exercises the same registration
 * the app gets, so a wrong event class or a missing hook fails here.
 *
 * Runs the real migration file rather than hand-rolled schema, so drift
 * between what the migration creates and what the model queries shows up
 * as a failure instead of only in a real app.
 */
export async function createHarness(config: ActivityLogConfig = {}): Promise<Harness> {
  const app = new Application();
  const database = new DatabaseManager(app, { default: "sqlite", connections: {} });
  database.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
  app.instance(DATABASE_TOKEN, database);
  app.bind(SCHEMA_TOKEN, () => database.schema());

  const events = new EventDispatcher(app);
  app.instance(EVENTS_TOKEN, events);
  setCurrentApp(app);

  app.config.set("activity-logs", config);

  const provider = new ActivityLogServiceProvider(app);
  provider.register();

  for (const [eventClass, listener] of provider.listeners()) {
    events.listen(eventClass as never, listener as never);
  }

  await createActivityLogsTable.up();

  await Schema.create("posts", (table) => {
    table.string("id").primary();
    table.string("title");
    table.text("body");
    table.text("secret_note").nullable();
    table.text("settings").nullable();
    table.softDeletes();
  });

  await Schema.create("widgets", (table) => {
    table.string("id").primary();
    table.string("name");
    table.string("internal");
  });

  await Schema.create("users", (table) => {
    table.string("id").primary();
    table.string("email");
    table.string("password");
  });

  return {
    app,
    events,
    logger: app.make<ActivityLogger>(ACTIVITY_LOG_TOKEN),
    rows: async () => {
      const found = await database
        .driver()
        .kysely.selectFrom("activity_logs")
        .selectAll()
        .orderBy("created_at", "asc")
        .orderBy("rowid", "asc")
        .execute();

      return found.map((row) => ({
        type: row.type as string,
        action: row.action as string | null,
        model_type: row.model_type as string,
        model_id: row.model_id as string,
        user_id: row.user_id as string | null,
        message: row.message as string | null,
        data:
          row.data === null ? null : (JSON.parse(row.data as string) as Record<string, unknown>),
      }));
    },
    cleanup: () => clearCurrentApp(),
  };
}
