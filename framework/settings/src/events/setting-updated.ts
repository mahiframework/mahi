import { AbstractEvent } from "@mahiframework/events";

/**
 * A setting's value changed.
 *
 * Fired once per setting, AFTER the row is written and the cache
 * forgotten — so a listener that reads the setting back sees the new
 * value rather than racing the invalidation. A `setMany()` of three
 * settings fires three of these.
 *
 * Carries `previous` as well as `value`, because the useful listeners
 * are the ones that care about the transition: "the import feature was
 * just turned off, drain the queue" is not answerable from the new value
 * alone. `previous` is the setting's *effective* old value, so it is the
 * declared default when nothing was stored rather than a null standing
 * in for one.
 *
 * Both are the decoded, model-side values — a `DateTime` for a
 * `datetime` setting, not its ISO string.
 *
 * Listeners are awaited inside the write, so a slow one slows the write.
 * An app with none can turn the dispatch off with `events: false`.
 */
export class SettingUpdated extends AbstractEvent {
  static override eventName = "settings.SettingUpdated";

  constructor(
    readonly key: string,
    readonly value: unknown,
    readonly previous: unknown,
    /** Who changed it, or null for an unattributed write. */
    readonly editedByUserId: string | null,
  ) {
    super();
  }
}
