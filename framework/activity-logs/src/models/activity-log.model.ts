import { Cast, Model } from "@mahiframework/database";
import type { BuilderFor } from "@mahiframework/database";
import type { DateTime } from "@mahiframework/datetime";

/** The attributes of the `activity_logs` table. */
export interface ActivityLogAttributes {
  id: string;
  /** `"resource"`, `"security"`, or whatever the application chose. */
  type: string;
  /** `"created"`, `"login"`, …; null when `type` alone says enough. */
  action: string | null;
  /** The affected model's `morphAlias()`. */
  model_type: string;
  /** The affected model's key, stringified. */
  model_id: string;
  /** Who triggered it, or null for a system/unauthenticated action. */
  user_id: string | null;
  /** A short summary, when `type` + `action` is not enough. */
  message: string | null;
  /** JSON payload: captured attributes, changes, and `context`. */
  data: Record<string, unknown> | null;
  created_at: DateTime;
}

/**
 * Read-model over the `activity_logs` table.
 *
 * Exported because an application needs to read what the package wrote,
 * and a read model is most of the table's value. The package itself never
 * queries it beyond the prune command.
 *
 * `keyType: "uuid"` so the id is client-generated: an insert then needs no
 * `RETURNING` round-trip, which matters on a table written once per
 * mutation. Not a snowflake, which would mean depending on
 * `@mahiframework/snowflake` for an id nothing sorts by.
 *
 * `timestamps` sets `updatedAt: null` because a row is immutable, and
 * `morphName` is set so the model can appear in a queued job payload.
 *
 * WRITES TO THIS TABLE ARE NEVER THEMSELVES LOGGED. The resource listener
 * hard-excludes this model regardless of configuration; without that, one
 * mutation would recurse until the stack blew.
 */
export class ActivityLog extends Model<ActivityLogAttributes>()({
  table: "activity_logs",
  primaryKey: "id",
  keyType: "uuid",
  morphName: "ActivityLog",
  timestamps: { createdAt: "created_at", updatedAt: null },
  casts: {
    data: Cast.json<Record<string, unknown>>(),
    created_at: Cast.datetime(),
  },
}) {
  /**
   * One record's history, newest first.
   *
   * `(model_type, model_id, created_at)` is the composite-indexed triple
   * the table exists to serve. Pass `Post.morphAlias()` rather than a
   * literal, so a later morph-map change moves both sides at once.
   */
  static for(
    modelType: string,
    modelId: string | number | bigint,
  ): BuilderFor<ActivityLogAttributes, ActivityLog> {
    return this.query()
      .where("model_type", modelType)
      .where("model_id", String(modelId))
      .orderBy("created_at", "desc");
  }

  /** Everything one user did, newest first. */
  static by(userId: string | number | bigint): BuilderFor<ActivityLogAttributes, ActivityLog> {
    return this.query().where("user_id", String(userId)).orderBy("created_at", "desc");
  }

  /** Every row of one type (`"security"`, `"billing"`, …), newest first. */
  static ofType(type: string): BuilderFor<ActivityLogAttributes, ActivityLog> {
    return this.query().where("type", type).orderBy("created_at", "desc");
  }
}
