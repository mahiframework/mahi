import { Cast, Model } from "@mahiframework/database";
import type { DateTime } from "@mahiframework/datetime";

/**
 * A customised setting: one row per setting whose value differs from its
 * declared default.
 *
 * ## Named `SettingRecord`, not `Setting`
 *
 * `Setting` is the facade, which is the surface application code touches
 * constantly — `Setting.get("key")` reads better than `Settings.get()`,
 * so the facade gets the good name and the model takes the compound one.
 * Reaching for this class directly is unusual; the registry is the
 * supported way in, and it is what keeps the cache honest.
 *
 * ## `key` is the primary key
 *
 * A setting has at most one row, so re-setting one overwrites rather
 * than accumulating, and reading one is a single indexed PK lookup. Same
 * shape as `password_reset_tokens`, for the same reason.
 *
 * This is also what makes uniqueness enforceable at all. A nullable
 * column in a composite unique index cannot be made portable:
 * `nullsNotDistinct` is Postgres 15+ only and *throws* on SQLite and
 * MySQL, so a `(key, user_id)` unique index with a nullable `user_id`
 * would permit unlimited duplicate rows for the same global setting. A
 * natural PK on `key` sidesteps it entirely.
 *
 * ## No row means "the default"
 *
 * There is deliberately no `null` value and no "unset" flag. A setting
 * is either stored or it is its declared default, and reverting one
 * deletes the row. Any third state would have to be reconciled against
 * the default on every read.
 *
 * `timestamps: true` with both columns: unlike an activity log, a
 * setting row is mutable — `updated_at` is when the value last changed,
 * which is half of the audit trail `edited_by_user_id` completes.
 */
export interface SettingRecordAttributes {
  /** The setting's declared `name`. */
  key: string;

  /**
   * The JSON-encoded value.
   *
   * Encoded rather than raw so `false`, `0`, `""` and `null` survive the
   * round trip as themselves instead of collapsing into something
   * indistinguishable from an absent row. `Cast.json()` is deliberately
   * NOT used: the registry decodes per the setting's declared type, and
   * a cast here would decode it twice.
   */
  value: string;

  /**
   * Who last changed it, or null for an unattributed write (a seeder, a
   * CLI command, a queue worker).
   *
   * TEXT, not the app's key type: an app's user may key on a snowflake,
   * a UUID or an int, and only text holds all three. No foreign key —
   * `users` is app-owned and the framework cannot assume its name.
   */
  edited_by_user_id: string | null;

  created_at: DateTime;
  updated_at: DateTime;
}

export class SettingRecord extends Model<SettingRecordAttributes>()({
  table: "settings",
  primaryKey: "key",
  morphName: "SettingRecord",
  casts: {
    created_at: Cast.datetime(),
    updated_at: Cast.datetime(),
  },
}) {}
