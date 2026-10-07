import { ServiceProvider } from "@mahiframework/core";
import type { AnyModelClass, RegisteredMigration } from "@mahiframework/database";
import { WatchtowerManager } from "./watchtower-manager.js";
import { resolveConfig, type WatchtowerConfig } from "./watchtower-config.js";
import { configErrors } from "./validate-config.js";
import { WatchtowerConfigError } from "./errors.js";
import { WatchtowerJobType } from "./models/watchtower-job-type.model.js";
import { WatchtowerJobRun } from "./models/watchtower-job-run.model.js";
import createWatchtowerTables from "./migrations/0001_create_watchtower_tables.js";
import createWatchtowerJobsTable from "./migrations/0002_create_watchtower_jobs_table.js";
import { WATCHTOWER_TOKEN } from "./tokens.js";

export { WATCHTOWER_TOKEN };

/**
 * Registers the `WatchtowerManager` singleton, the run-history models and
 * the migrations.
 *
 * ORDERING: list this provider AFTER `DatabaseServiceProvider` (it owns
 * three tables and two models), AFTER `CacheServiceProvider` (pause,
 * deferral and heartbeat keys live in a cache store), and AFTER
 * `EventsServiceProvider` (it contributes `listeners()`). You cannot
 * enforce any of that; the app's `config/app.ts` decides, and this
 * docstring is the whole mechanism.
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

  /** Registered so a queued job can carry either row. */
  models(): AnyModelClass[] {
    return [
      WatchtowerJobType as unknown as AnyModelClass,
      WatchtowerJobRun as unknown as AnyModelClass,
    ];
  }
}
