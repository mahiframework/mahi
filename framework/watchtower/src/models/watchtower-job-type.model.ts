import { Cast, Model } from "@mahiframework/database";
import type { BuilderFor } from "@mahiframework/database";
import type { DateTime } from "@mahiframework/datetime";

/** The attributes of the `watchtower_job_types` table. */
export interface WatchtowerJobTypeAttributes {
  id: string;

  /**
   * The name the job is registered under, e.g. `"app.jobs.sync-invoice"`.
   *
   * The registry key, not the class name: that is what a queue payload
   * carries and what survives a rename of the class. Unique.
   */
  name: string;

  /**
   * The constructor name, e.g. `"SyncInvoiceJob"`, for display.
   *
   * Recorded separately because it is the name an operator recognises
   * from a stack trace, and it can change while `name` stays stable.
   * Nullable: a job whose class could not be resolved still gets a type
   * row, because "this name keeps failing and nothing can run it" is
   * exactly the thing worth seeing.
   */
  class_name: string | null;

  first_seen_at: DateTime;
  last_seen_at: DateTime;
}

/**
 * One kind of job, created the first time one is seen.
 *
 * Exists so run rows have something to group by that outlives any single
 * dispatch, and so the dashboard can list job types an app has stopped
 * dispatching without scanning the whole run table.
 *
 * `keyType: "uuidv7"` so the id is client-generated: the insert then
 * needs no `RETURNING` round-trip. v7 rather than v4 so `ORDER BY id` is
 * chronological and inserts keep index locality.
 *
 * Rows are never deleted by this package. `watchtower:prune` trims
 * `watchtower_job_runs`; a type row is a handful of bytes and losing it
 * would lose `first_seen_at`, which is the only record of when a job
 * class entered the system.
 */
export class WatchtowerJobType extends Model<WatchtowerJobTypeAttributes>()({
  table: "watchtower_job_types",
  primaryKey: "id",
  keyType: "uuidv7",
  morphName: "WatchtowerJobType",
  timestamps: false,
  casts: {
    first_seen_at: Cast.datetime(),
    last_seen_at: Cast.datetime(),
  },
}) {
  /** The type row for a registered job name, if one exists. */
  static findByName(name: string): BuilderFor<WatchtowerJobTypeAttributes, WatchtowerJobType> {
    return this.query().where("name", name);
  }

  /** Every type seen since `since`, most recently active first. */
  static activeSince(since: DateTime): BuilderFor<WatchtowerJobTypeAttributes, WatchtowerJobType> {
    return this.query().where("last_seen_at", ">=", since).orderBy("last_seen_at", "desc");
  }
}
