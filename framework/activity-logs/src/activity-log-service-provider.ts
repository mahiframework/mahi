import { ServiceProvider } from "@mahiframework/core";
import type { AnyModelClass, RegisteredMigration } from "@mahiframework/database";
import { ModelCreated, ModelDeleted, ModelRestored, ModelUpdated } from "@mahiframework/database";
import { AuthEvent } from "@mahiframework/auth";
import type { ListenerRegistration } from "@mahiframework/events";
import type { HttpPipe } from "@mahiframework/http";
import { ActivityLogger } from "./activity-logger.js";
import { resolveConfig, type ActivityLogConfig } from "./activity-log-config.js";
import { ActivityLog } from "./models/activity-log.model.js";
import { ResourceActivityListener } from "./listeners/resource-activity.listener.js";
import { SecurityActivityListener } from "./listeners/security-activity.listener.js";
import { ActivityLogsCheckCommand } from "./commands/activity-logs-check.js";
import { ActivityLogsPruneCommand } from "./commands/activity-logs-prune.js";
import createActivityLogsTable from "./migrations/0001_create_activity_logs_table.js";
import { ACTIVITY_LOG_TOKEN } from "./tokens.js";

export { ACTIVITY_LOG_TOKEN };

/**
 * Registers the `ActivityLogger` singleton, the listeners that feed it,
 * and the pipe that seeds request context.
 *
 * ORDERING: list this provider AFTER `EventsServiceProvider` (it
 * contributes `listeners()`), AFTER `DatabaseServiceProvider` (it owns a
 * table and a model), AFTER `AuthServiceProvider` (so its context pipe
 * runs inside the ambient auth scope and the actor is resolvable), and
 * BEFORE `HttpServiceProvider` (so its pipe is collected before routes
 * are). You cannot enforce any of that; the app's `config/app.ts`
 * decides, and this docstring is the whole mechanism.
 */
export class ActivityLogServiceProvider extends ServiceProvider {
  register(): void {
    // No `config.merge()` of defaults. Every default is applied in
    // `resolveConfig()` with `??`, which is both the single place to read
    // them and immune to merge-order surprises: `ConfigRepository.merge()`
    // currently deep-merges the INCOMING values last, so contributing
    // defaults that way would silently overwrite the app's own config
    // rather than layering under it.
    this.app.singleton(ACTIVITY_LOG_TOKEN, (app) => {
      // `get`, not `require`: an app that installs the package and
      // configures nothing gets working defaults rather than a boot
      // failure.
      const config = app.config.get<ActivityLogConfig>("activity-logs") ?? {};

      return new ActivityLogger(app, resolveConfig(config));
    });
  }

  /**
   * Four past-tense model classes plus the abstract `AuthEvent` base.
   *
   * The model events are registered individually rather than through a
   * `"model.*"` pattern, which would also match `retrieved` — on every
   * row read. The auth half is a single registration precisely because
   * `AuthEvent` is abstract: one entry catches all fourteen subclasses
   * and any added later, which is what a security log needs.
   */
  listeners(): ReadonlyArray<ListenerRegistration> {
    return [
      [ModelCreated, ResourceActivityListener],
      [ModelUpdated, ResourceActivityListener],
      [ModelDeleted, ResourceActivityListener],
      [ModelRestored, ResourceActivityListener],
      [AuthEvent, SecurityActivityListener],
    ] as const;
  }

  /**
   * Seed the request context the default `config.context` thunk reads.
   *
   * The HTTP kernel opens one `ContextRepository` overlay per request,
   * outermost of everything, so this pipe is already inside it and the
   * values are isolated per request.
   *
   * Both values are optional: `request.ip()` is the socket peer rather
   * than `X-Forwarded-For` (deliberately — trusting the header gave an
   * attacker unlimited login attempts by incrementing a string), and it
   * is `undefined` under in-process dispatch. A key with no value is
   * omitted rather than written as null.
   */
  middleware(): HttpPipe[] {
    return [
      (request, next) => {
        const ip = request.ip();
        const userAgent = request.userAgent();

        if (ip !== undefined) {
          this.app.context.add("ip", ip);
        }

        if (userAgent !== undefined) {
          this.app.context.add("user_agent", userAgent);
        }

        return next(request);
      },
    ];
  }

  /**
   * Static rather than a `migrations()` directory path, so it resolves
   * inside a bundled binary. See `QueueServiceProvider.migrationSources()`.
   */
  migrationSources(): RegisteredMigration[] {
    return [{ name: "0001_create_activity_logs_table", migration: createActivityLogsTable }];
  }

  /** Registered so a queued job can carry an `ActivityLog`. */
  models(): AnyModelClass[] {
    return [ActivityLog as unknown as AnyModelClass];
  }

  commands() {
    return [ActivityLogsPruneCommand, ActivityLogsCheckCommand];
  }
}
