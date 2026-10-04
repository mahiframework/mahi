import { randomUUID } from "node:crypto";
import type { Application } from "@mahiframework/core";
import { DateTime } from "@mahiframework/datetime";
import { RESOURCE_TYPE, SECURITY_TYPE, type ResolvedConfig } from "./activity-log-config.js";
import { currentActorKey, modelKeyOf, morphAliasOf, stringifyKey } from "./actor.js";
import { capMessage, capPayload } from "./capture/serialize.js";
import { maskValue } from "./capture/mask.js";
import { ActivityLog } from "./models/activity-log.model.js";
import { activityLogsSuppressed } from "./suppression.js";

export interface LogOptions {
  /** Required, with no default: see the class docstring. */
  type: string;
  action?: string | null;
  /** A model instance. Mutually exclusive with `modelType`/`modelId`. */
  model?: object;
  modelType?: string;
  modelId?: string | number | bigint;
  /**
   * Who did it. Omitted means "the ambient actor"; an explicit `null`
   * means "deliberately unattributed", which is not the same thing.
   */
  user?: object | string | number | bigint | null;
  message?: string | null;
  data?: Record<string, unknown> | null;
}

/**
 * Writes rows to `activity_logs`. Every path in the package funnels here.
 *
 * `type` is required on `log()` with no default. A default would send
 * every miswritten call into one bucket, and the three purposes —
 * resource, security, application-defined — are the package's single
 * organising idea.
 *
 * The write is SYNCHRONOUS AND IN-BAND, never queued. Three reasons, the
 * first decisive: the from→to pair an update records is only readable
 * between `syncChanges()` and `syncOriginal()` inside the `updated`
 * dispatch, and a queued listener's payload is a shallow spread with the
 * constructor never re-run, so neither the instance nor its `original`
 * snapshot survives the trip. Beyond that, `listenQueued` has no pattern
 * form (which the MFA subscription needs), and the write is one INSERT
 * with a client-generated id, so queueing it would trade one local insert
 * for a serialise, an insert into `jobs`, a poll, a deserialise and an
 * insert.
 */
export class ActivityLogger {
  constructor(
    private readonly app: Application,
    private readonly config: ResolvedConfig,
  ) {}

  /** The resolved config, for the listeners and the check command. */
  get settings(): ResolvedConfig {
    return this.config;
  }

  /**
   * Record an application-defined activity.
   *
   * Returns the row, or `null` when logging is disabled or suppressed, so
   * a caller can distinguish "written" from "deliberately skipped"
   * without reaching into config.
   */
  async log(options: LogOptions): Promise<ActivityLog | null> {
    if (!this.enabled()) {
      return null;
    }

    const subject = this.resolveSubject(options);

    if (subject === null) {
      return null;
    }

    return this.write({
      type: options.type,
      action: options.action ?? null,
      modelType: subject.modelType,
      modelId: subject.modelId,
      userId: this.resolveUser(options.user),
      message: options.message ?? null,
      // Masked on this path too: a developer-supplied payload is exactly
      // where a token gets logged by accident.
      data: this.maskData(options.data ?? null),
    });
  }

  /** Record a CRUD event against a tracked model. */
  async resource(
    action: string,
    modelType: string,
    modelId: string,
    data: Record<string, unknown> | null,
    userId: string | null,
  ): Promise<ActivityLog | null> {
    if (!this.enabled()) {
      return null;
    }

    return this.write({
      type: RESOURCE_TYPE,
      action,
      modelType,
      modelId,
      userId,
      message: null,
      data,
    });
  }

  /** Record an authentication or security event against a user. */
  async security(
    action: string,
    modelId: string,
    data: Record<string, unknown> | null,
    userId: string | null,
  ): Promise<ActivityLog | null> {
    if (!this.enabled() || !this.config.security.enabled || !this.recordsAction(action)) {
      return null;
    }

    return this.write({
      type: SECURITY_TYPE,
      action,
      modelType: this.config.security.userType,
      modelId,
      userId,
      message: null,
      data: this.maskData(data),
    });
  }

  /** The ambient actor, for a listener that has no user in hand. */
  actor(): string | null {
    return currentActorKey(this.config.security.userKey);
  }

  private enabled(): boolean {
    return this.config.enabled && !activityLogsSuppressed();
  }

  /** Whether `config.security.actions` admits this action. */
  private recordsAction(action: string): boolean {
    const actions = this.config.security.actions;

    return actions === "all" || actions.has(action);
  }

  private async write(row: {
    type: string;
    action: string | null;
    modelType: string;
    modelId: string;
    userId: string | null;
    message: string | null;
    data: Record<string, unknown> | null;
  }): Promise<ActivityLog> {
    const context = this.context();
    const merged = context === null ? row.data : { ...(row.data ?? {}), context };
    const capped = capPayload(merged, this.config.maxDataBytes);

    return ActivityLog.create({
      id: randomUUID(),
      type: row.type,
      action: row.action,
      model_type: row.modelType,
      model_id: row.modelId,
      user_id: row.userId,
      message: capMessage(row.message, this.config.maxMessageLength),
      data: capped.data,
      created_at: DateTime.now(),
    });
  }

  /**
   * The ambient request data merged under `data.context`.
   *
   * A thunk that throws must not take the write down with it: context is
   * enrichment, and a row with no IP beats no row at all.
   */
  private context(): Record<string, unknown> | null {
    if (this.config.context === null) {
      return null;
    }

    let values: Record<string, unknown> | undefined;

    try {
      values = this.config.context();
    } catch (error) {
      this.app.logger.error("activity-logs: the context thunk threw", { error });

      return null;
    }

    if (values === undefined || Object.keys(values).length === 0) {
      return null;
    }

    return values;
  }

  private maskData(data: Record<string, unknown> | null): Record<string, unknown> | null {
    if (data === null) {
      return null;
    }

    return maskValue(data, this.config.mask, this.config.maskWith) as Record<string, unknown>;
  }

  /**
   * `model` and `modelType`/`modelId` are mutually exclusive, and one is
   * required: there is no subjectless row.
   */
  private resolveSubject(options: LogOptions): { modelType: string; modelId: string } | null {
    if (options.model !== undefined) {
      const modelType = morphAliasOf(options.model);
      const modelId = modelKeyOf(options.model);

      if (modelType === undefined || modelId === null) {
        this.app.logger.error(
          "activity-logs: could not resolve a subject from the given model; nothing was logged",
          { type: options.type, action: options.action },
        );

        return null;
      }

      return { modelType, modelId };
    }

    if (options.modelType !== undefined && options.modelId !== undefined) {
      return { modelType: options.modelType, modelId: String(options.modelId) };
    }

    this.app.logger.error(
      "activity-logs: log() needs either `model` or both `modelType` and `modelId`",
      { type: options.type, action: options.action },
    );

    return null;
  }

  /** `undefined` means the ambient actor; an explicit `null` means none. */
  private resolveUser(user: LogOptions["user"]): string | null {
    if (user === undefined) {
      return this.actor();
    }

    if (user === null) {
      return null;
    }

    if (typeof user === "object") {
      return stringifyKey(user, this.config.security.userKey);
    }

    return String(user);
  }
}
