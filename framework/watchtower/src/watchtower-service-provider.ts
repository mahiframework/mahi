import { QUEUE_TOKEN, ServiceProvider } from "@mahiframework/core";
import {
  DATABASE_TOKEN,
  type AnyModelClass,
  type DatabaseManager,
  type RegisteredMigration,
} from "@mahiframework/database";
import type { ListenerRegistration } from "@mahiframework/events";
import {
  JobFailed,
  JobProcessed,
  JobProcessing,
  type JobClass,
  type QueueManager,
} from "@mahiframework/queue";
import { WatchtowerManager } from "./watchtower-manager.js";
import { RecordJobRunListener } from "./listeners/record-job-run.listener.js";
import { RECORD_JOB_RUN_JOB, RecordJobRunJob } from "./jobs/record-job-run.job.js";
import { resolveConfig, type WatchtowerConfig } from "./watchtower-config.js";
import { configErrors } from "./validate-config.js";
import { WatchtowerConfigError } from "./errors.js";
import { WatchtowerQueueDriver } from "./drivers/watchtower-queue-driver.js";
import { WatchtowerCheckCommand } from "./commands/watchtower-check.js";
import { WatchtowerPauseCommand } from "./commands/watchtower-pause.js";
import { WatchtowerPruneCommand } from "./commands/watchtower-prune.js";
import { WatchtowerRestartCommand } from "./commands/watchtower-restart.js";
import { WatchtowerUnpauseCommand } from "./commands/watchtower-unpause.js";
import { WatchtowerJobType } from "./models/watchtower-job-type.model.js";
import { WatchtowerJobRun } from "./models/watchtower-job-run.model.js";
import createWatchtowerTables from "./migrations/0001_create_watchtower_tables.js";
import createWatchtowerJobsTable from "./migrations/0002_create_watchtower_jobs_table.js";
import { WATCHTOWER_CONNECTION, WATCHTOWER_TOKEN } from "./tokens.js";

export { WATCHTOWER_TOKEN };

/** `connections.watchtower` in `config/queue.ts`. */
interface WatchtowerConnectionConfig {
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
 * Registers the `WatchtowerManager` singleton, the run-history models and
 * the migrations.
 *
 * ORDERING: list this provider AFTER `QueueServiceProvider` — a hard
 * requirement, since `register()` resolves `QUEUE_TOKEN` to register the
 * `watchtower` connection, the same arrangement `RedisServiceProvider`
 * has with the three managers it extends. Also AFTER
 * `DatabaseServiceProvider` (it owns four tables and two models), AFTER
 * `CacheServiceProvider` (pause, deferral and heartbeat keys live in a
 * cache store), and AFTER `EventsServiceProvider` (it contributes
 * `listeners()`). You cannot enforce any of that; the app's
 * `config/app.ts` decides, and this docstring is the whole mechanism.
 */
export class WatchtowerServiceProvider extends ServiceProvider {
  register(): void {
    // No `config.merge()` of defaults. Every default is applied in
    // `resolveConfig()` with `??`, which is both the single place to read
    // them and immune to merge-order surprises: `ConfigRepository.merge()`
    // currently deep-merges the INCOMING values last, so contributing
    // defaults that way would silently overwrite the app's own config
    // rather than layering under it.
    this.app.singleton(WATCHTOWER_TOKEN, (app) => {
      // `get`, not `require`: an app that installs the package and
      // configures nothing gets one worker on the `default` queue rather
      // than a boot failure.
      const config = resolveConfig(app.config.get<WatchtowerConfig>("watchtower") ?? {});

      // Validated here rather than at first use, and carrying EVERY
      // problem rather than the first. Each condition this rejects
      // describes work that silently does not happen — a process that
      // drains no queues, a `fifo` promise two workers cannot keep —
      // which is the worst failure mode available to a queue.
      const errors = configErrors(config);

      if (errors.length > 0) {
        throw new WatchtowerConfigError(errors);
      }

      return new WatchtowerManager(app, config);
    });

    this.registerQueueConnection();
  }

  /**
   * Register the `watchtower` queue connection.
   *
   * Guarded on the token so an app without the queue package registered
   * is simply unaffected, the `app.has(TOKEN)` pattern
   * `RedisServiceProvider` uses for the same reason. The driver is
   * registered but never *resolved* unless config points something at
   * it, so merely listing this provider costs nothing.
   *
   * Neither `fifo` nor the cooldown hook is wired here, and that is
   * deliberate: both are properties of a *process*, and a container
   * factory has no process. The worker builds its own instance with
   * `fifo` and `onDefer` taken from the process it is running
   * (`watchtower:worker`).
   *
   * So a driver resolved through the manager — by `Bus.dispatch()`, by
   * `queue:failed --connection=watchtower` — releases the ordinary way.
   * That is correct: with no worker involved there is no process to hold.
   */
  private registerQueueConnection(): void {
    if (!this.app.has(QUEUE_TOKEN)) {
      return;
    }

    const queue = this.app.make<QueueManager>(QUEUE_TOKEN);

    queue.extend(WATCHTOWER_CONNECTION, (app) => {
      const settings = (queue.connectionConfig(WATCHTOWER_CONNECTION) ??
        {}) as WatchtowerConnectionConfig;
      const database = app.make<DatabaseManager>(DATABASE_TOKEN);
      // A named `connection` points this at a database other than the
      // app's default, for a dedicated queue database.
      const driver = database.driver(settings.connection);

      // The dialect — which selects the reservation strategy — is read
      // from the connection itself by the driver, so it cannot drift.
      return new WatchtowerQueueDriver(driver.kysely, {
        queue: settings.queue ?? "default",
        retryAfterSeconds: settings.retryAfter ?? 90,
        ...(settings.popBatchSize !== undefined ? { popBatchSize: settings.popBatchSize } : {}),
        connectionName: WATCHTOWER_CONNECTION,
      });
    });
  }

  /**
   * Static rather than a `migrations()` directory path, so it resolves
   * inside a bundled binary. See `QueueServiceProvider.migrationSources()`.
   *
   * Two migrations because they are independently meaningful: an app can
   * run `0001` alone and get the run history on its existing queue
   * connection, without adopting this package's driver or supervisor.
   */
  migrationSources(): RegisteredMigration[] {
    return [
      { name: "0001_create_watchtower_tables", migration: createWatchtowerTables },
      { name: "0002_create_watchtower_jobs_table", migration: createWatchtowerJobsTable },
    ];
  }

  /**
   * Record every job the worker reports on.
   *
   * All three events, subscribed as classes. The listener itself decides
   * what to ignore — it hard-excludes its own job to avoid recursing, so
   * that cannot be expressed by subscribing selectively here.
   *
   * One listener instance per registration is fine: its only state is
   * the in-memory start-time map, and `EventDispatcher` constructs the
   * class once per event type.
   */
  listeners(): ReadonlyArray<ListenerRegistration> {
    return [
      [JobProcessing, RecordJobRunListener],
      [JobProcessed, RecordJobRunListener],
      [JobFailed, RecordJobRunListener],
    ] as const;
  }

  /**
   * The queued-recording job.
   *
   * It MUST be here: `QueueManager.dispatch()` resolves a job's name
   * through `JobRegistry.nameFor()`, which throws for an unregistered
   * class — so an omission surfaces at the first recorded run rather
   * than at boot.
   */
  jobs(): Record<string, JobClass> {
    return { [RECORD_JOB_RUN_JOB]: RecordJobRunJob };
  }

  /** Registered so a queued job can carry either row. */
  models(): AnyModelClass[] {
    return [
      WatchtowerJobType as unknown as AnyModelClass,
      WatchtowerJobRun as unknown as AnyModelClass,
    ];
  }

  commands() {
    return [
      WatchtowerCheckCommand,
      WatchtowerPauseCommand,
      WatchtowerUnpauseCommand,
      WatchtowerRestartCommand,
      WatchtowerPruneCommand,
    ];
  }
}
