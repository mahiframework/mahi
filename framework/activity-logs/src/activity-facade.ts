import { Facade } from "@mahiframework/facades";
import type { ActivityLogger, LogOptions } from "./activity-logger.js";
import type { ActivityLog } from "./models/activity-log.model.js";
import { RESOURCE_TYPE, SECURITY_TYPE } from "./activity-log-config.js";
import { withoutActivityLogs } from "./suppression.js";
import { ACTIVITY_LOG_TOKEN } from "./tokens.js";

/**
 * Thin facade over the `ActivityLogger` singleton bound at
 * `ACTIVITY_LOG_TOKEN`, for call sites that would otherwise read
 * `app().make<ActivityLogger>(ACTIVITY_LOG_TOKEN).log(...)`.
 *
 *   await Activity.log({ type: "billing", action: "invoice_sent", model: invoice });
 *   await Activity.without(() => importer.run());
 *
 * Named `Activity` (singular) rather than `Activities`, even though the
 * package already exports an `ActivityLog` model: `Activity.log()` reads
 * better than `Activities.log()`, and the model keeps the compound name
 * it shares with its table.
 *
 * `resource()` and `security()` are not shorthand for less typing. They
 * pin `type` to the right constant, so an app adding a row by hand cannot
 * land it in the wrong bucket by spelling the string differently.
 *
 * Prefer constructor-injecting `ActivityLogger` (via
 * `ACTIVITY_LOG_TOKEN`) where that is practical; use this only where
 * threading `app`/`ActivityLogger` through is genuinely inconvenient,
 * same guidance as `app()` itself.
 */
export class Activity extends Facade<ActivityLogger>(() => ACTIVITY_LOG_TOKEN) {
  /**
   * Record an application-defined activity.
   *
   * Returns `null` when logging is disabled or suppressed, so a caller
   * can tell "written" from "skipped" without reading config.
   */
  static log(options: LogOptions): Promise<ActivityLog | null> {
    return this.instance().log(options);
  }

  /** Record a `resource` row for a model the package is not tracking. */
  static resource(
    action: string,
    options: Omit<LogOptions, "type" | "action">,
  ): Promise<ActivityLog | null> {
    return this.instance().log({ ...options, type: RESOURCE_TYPE, action });
  }

  /** Record a `security` row explicitly. */
  static security(
    action: string,
    options: Omit<LogOptions, "type" | "action">,
  ): Promise<ActivityLog | null> {
    return this.instance().log({ ...options, type: SECURITY_TYPE, action });
  }

  /**
   * Run `callback` with activity logging switched off.
   *
   * A package-local flag, not `Event.suppress()`: suppressing the
   * underlying events would also silence the application's own listeners
   * on them, which is more than the caller asked for.
   */
  static without<T>(callback: () => T | Promise<T>): Promise<T> {
    return withoutActivityLogs(callback);
  }
}
