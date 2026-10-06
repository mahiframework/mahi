import type { Application } from "@mahiframework/core";
import type { ModelLifecycleEvent } from "@mahiframework/database";
import type { Listener } from "@mahiframework/events";
import { SettingRecord } from "../models/setting-record.model.js";
import type { SettingsRegistry } from "../settings-registry.js";
import { SETTINGS_TOKEN } from "../tokens.js";

/**
 * Forgets the cached settings map when a `settings` row is written
 * outside this package.
 *
 * `SettingsRegistry` already forgets the cache on every write it
 * performs, so this listener exists entirely for the writes it never
 * sees: a seeder calling `SettingRecord.create(...)`, a migration
 * backfilling a value, an admin screen that went straight to the ORM.
 * Without it the application would keep reading the old value until the
 * TTL expired.
 *
 * Subscribed to the three past-tense classes individually, not a
 * `"model.*"` pattern. The pattern would also match `retrieved`, which
 * fires on every row read in the application, so this would sit on the
 * hottest path only to filter itself out. `ModelSaved` is skipped: it
 * fires alongside both `ModelCreated` and `ModelUpdated` and would
 * double the work.
 *
 * ## Errors are not swallowed
 *
 * `EventDispatcher` awaits listeners with no isolation and
 * `dispatchModelEvent` is awaited inside `save()`, so a throw here fails
 * the caller's `SettingRecord.create()`. That is the right trade, and
 * the opposite of the one `activity-logs` makes: a missing audit row is
 * a lost record, but a cache still serving the old value is the
 * application behaving contrary to its own configuration — a feature
 * left on after being turned off, a limit that did not take. Better the
 * write fails loudly and is retried than succeeds while leaving the
 * cache lying.
 */
export class InvalidateSettingsCacheListener implements Listener<ModelLifecycleEvent> {
  constructor(private readonly app: Application) {}

  async handle(event: ModelLifecycleEvent): Promise<void> {
    // Identity, not `morphAlias()`: an app may legitimately map this
    // model to some other alias, and the question here is only whether
    // the row that moved belongs to the table the cache is built from.
    if (event.model !== (SettingRecord as never)) {
      return;
    }

    await this.app.make<SettingsRegistry>(SETTINGS_TOKEN).forgetCache();
  }
}
