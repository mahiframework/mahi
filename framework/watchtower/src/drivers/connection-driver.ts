import { QUEUE_TOKEN, type Application } from "@mahiframework/core";
import { DATABASE_TOKEN, type DatabaseManager } from "@mahiframework/database";
import type { QueueManager } from "@mahiframework/queue";
import { WATCHTOWER_CONNECTION } from "../tokens.js";
import {
  WatchtowerQueueDriver,
  type WatchtowerQueueDriverOptions,
} from "./watchtower-queue-driver.js";

/** `connections.watchtower` in `config/queue.ts`. */
export interface WatchtowerConnectionConfig {
  /** Which *database* connection holds `watchtower_jobs`. The app's default when omitted. */
  connection?: string;
  /** The default named queue this connection pushes to. Default `"default"`. */
  queue?: string;
  /**
   * Seconds before a reserved job is presumed abandoned. Must exceed the
   * longest a job can run, including its own timeout. Default 90.
   */
  retryAfter?: number;
  /** Candidate rows read per `pop()` on SQLite. Default 10. */
  popBatchSize?: number;
}

/**
 * A driver for the `watchtower` connection, built from its config.
 *
 * The one place `connections.watchtower` becomes a driver, shared by the
 * queue manager's connection and by every worker child. A worker builds
 * its own instance because `fifo` and `onDefer` belong to the process it
 * runs, and everything else has to match what the connection was
 * configured with: a child that fell back to the defaults would reclaim a
 * long job after 90 seconds and run it twice, or read a queue database
 * other than the one jobs are pushed to.
 *
 * The dialect, which selects the reservation strategy, is read from the
 * database connection itself by the driver, so it cannot drift.
 */
export function watchtowerConnectionDriver(
  app: Application,
  processOptions: Pick<WatchtowerQueueDriverOptions, "fifo" | "onDefer"> = {},
): WatchtowerQueueDriver {
  const settings = (
    app.has(QUEUE_TOKEN)
      ? (app.make<QueueManager>(QUEUE_TOKEN).connectionConfig(WATCHTOWER_CONNECTION) ?? {})
      : {}
  ) as WatchtowerConnectionConfig;

  // A named `connection` points this at a database other than the app's
  // default, for a dedicated queue database.
  const database = app.make<DatabaseManager>(DATABASE_TOKEN).driver(settings.connection);

  return new WatchtowerQueueDriver(database.kysely, {
    queue: settings.queue ?? "default",
    retryAfterSeconds: settings.retryAfter ?? 90,
    ...(settings.popBatchSize !== undefined ? { popBatchSize: settings.popBatchSize } : {}),
    connectionName: WATCHTOWER_CONNECTION,
    ...processOptions,
  });
}
