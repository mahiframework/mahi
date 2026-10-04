import type { Application } from "@mahiframework/core";
import type { Listener } from "@mahiframework/events";
import {
  ModelCreated,
  ModelDeleted,
  ModelRestored,
  ModelUpdated,
  type ModelLifecycleEvent,
} from "@mahiframework/database";
import type { ResolvedResource, ResourceAction } from "../activity-log-config.js";
import { ActivityLogger } from "../activity-logger.js";
import { ACTIVITY_LOG_TOKEN } from "../tokens.js";
import {
  captureAttributes,
  captureChanges,
  capturePlainUpdate,
  isModelInstance,
  type CapturableModel,
} from "../capture/capture.js";
import { maskRulesFor } from "../capture/mask.js";
import { modelKeyOf } from "../actor.js";
import { ActivityLog } from "../models/activity-log.model.js";

/** The static surface the listener reads off an event's model class. */
interface ModelClassLike {
  morphAlias(): string;
  primaryKeyColumn: string;
  softDeleteColumn?: string | undefined;
  hidden?: readonly string[];
  visible?: readonly string[];
}

/**
 * Turns model lifecycle events into `resource` rows.
 *
 * Subscribed to the four PAST-TENSE classes individually rather than to a
 * `"model.*"` pattern. The pattern would also match `creating`,
 * `updating`, `saving`, `saved` and `retrieved` — and `retrieved` fires
 * on every row read, so it would put this listener on the hottest path in
 * the application only to filter itself out. Four `instanceof` checks are
 * cheaper than a regex per dispatch and cannot silently acquire a new
 * event later.
 *
 * `ModelSaved` is deliberately not subscribed: it fires alongside both
 * `ModelCreated` and `ModelUpdated`, and would double every row.
 *
 * ## Errors are swallowed
 *
 * `EventDispatcher` awaits listeners with no isolation, and
 * `dispatchModelEvent` is awaited inside `save()`. So an uncaught throw
 * here fails the user's `save()`. An audit row is important; it is not
 * more important than the thing it audits, so the body is wrapped and
 * failures are logged. `config.throwOnFailure` inverts that for an app
 * under a regime where an unloggable action must not proceed.
 */
export class ResourceActivityListener implements Listener<ModelLifecycleEvent> {
  constructor(private readonly app: Application) {}

  async handle(event: ModelLifecycleEvent): Promise<void> {
    const logger = this.app.make<ActivityLogger>(ACTIVITY_LOG_TOKEN);

    try {
      await this.record(logger, event);
    } catch (error) {
      if (logger.settings.throwOnFailure) {
        throw error;
      }

      this.app.logger.error("activity-logs: failed to write a resource activity row", {
        event: event.eventName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async record(logger: ActivityLogger, event: ModelLifecycleEvent): Promise<void> {
    const modelClass = event.model as unknown as ModelClassLike;

    const action = this.actionFor(event, modelClass);

    if (action === null) {
      return;
    }

    const alias = modelClass.morphAlias();

    // A row written by this package must never itself be logged: the
    // first mutation would recurse until the stack blew. A hard guard,
    // not a convention, because `resources` is a string map and nothing
    // stops someone typing `ActivityLog: "full"`.
    if (alias === ActivityLog.morphAlias()) {
      return;
    }

    const resource = logger.settings.resources.get(alias);

    // Not configured is not the same as `capture: "none"`: the former
    // writes nothing at all, the latter writes a row with `data` null.
    if (resource === undefined || !resource.actions.has(action)) {
      return;
    }

    const payload = event.payload as CapturableModel & Record<string, unknown>;
    const modelId = modelKeyOf(payload) ?? String(payload[modelClass.primaryKeyColumn] ?? "");

    if (modelId === "") {
      return;
    }

    const data = this.capture(event, payload, modelClass, resource, logger);
    const actor = logger.actor();

    await logger.resource(action, alias, modelId, data, actor);

    await this.recordEmailChange(logger, event, payload, modelId, actor);
  }

  /**
   * Which of the five actions this event represents.
   *
   * The soft/hard delete split cannot be read off the instance.
   * `Model.delete()` writes `deleted_at` to the ROW but not to the
   * in-memory model — the instance was loaded before the update — so
   * `trashed()` is still false at `deleted` time on the soft-delete path,
   * which is exactly backwards. The only usable signal is whether the
   * class declares a soft-delete column at all.
   *
   * The known cost: `forceDelete()` on a soft-deleting model is recorded
   * as `soft_deleted`. Fixing it needs an additive change in
   * `@mahiframework/database` (a `forced` flag on the delete events, or a
   * distinct `ModelForceDeleted`), which belongs in its own change rather
   * than being guessed at here.
   */
  private actionFor(event: ModelLifecycleEvent, modelClass: ModelClassLike): ResourceAction | null {
    if (event instanceof ModelCreated) {
      return "created";
    }

    if (event instanceof ModelUpdated) {
      return "updated";
    }

    if (event instanceof ModelRestored) {
      return "restored";
    }

    if (event instanceof ModelDeleted) {
      return modelClass.softDeleteColumn === undefined ? "deleted" : "soft_deleted";
    }

    return null;
  }

  private capture(
    event: ModelLifecycleEvent,
    payload: CapturableModel & Record<string, unknown>,
    modelClass: ModelClassLike,
    resource: ResolvedResource,
    logger: ActivityLogger,
  ): Record<string, unknown> | null {
    const rules = maskRulesFor(modelClass, logger.settings.mask, resource.mask);
    const maskWith = logger.settings.maskWith;

    if (event instanceof ModelUpdated) {
      // `Model.update(id, values)` fires `updated` with a plain
      // cast-attributes object rather than an instance, so there is no
      // from-value to read. Degrades to column names regardless of mode.
      return isModelInstance(payload)
        ? captureChanges(payload, resource, rules, maskWith)
        : capturePlainUpdate(payload, resource, rules, modelClass.primaryKeyColumn);
    }

    return captureAttributes(payload, resource, rules, maskWith);
  }

  /**
   * An address change also writes a `security` row.
   *
   * Two rows for one act, deliberately. They answer different questions,
   * and a security query filtered to `type = "security"` must not have to
   * scan resource rows looking for a column name. The resource row still
   * records the update as an ordinary field change.
   */
  private async recordEmailChange(
    logger: ActivityLogger,
    event: ModelLifecycleEvent,
    payload: CapturableModel,
    modelId: string,
    actor: string | null,
  ): Promise<void> {
    if (!(event instanceof ModelUpdated) || !isModelInstance(payload)) {
      return;
    }

    const column = logger.settings.security.emailColumn;
    const changes = payload.getChanges();

    if (!Object.hasOwn(changes, column)) {
      return;
    }

    const alias = (event.model as unknown as ModelClassLike).morphAlias();

    if (alias !== logger.settings.security.userType) {
      return;
    }

    await logger.security(
      "email_changed",
      modelId,
      { from: payload.getOriginal(column), to: changes[column] },
      actor,
    );
  }
}
