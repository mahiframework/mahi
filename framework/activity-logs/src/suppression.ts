import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<true>();

/**
 * Run `callback` with activity logging switched off.
 *
 *   await Activity.without(() => importer.run());   // 50,000 rows, no logs
 *
 * Implemented with its own AsyncLocalStorage flag rather than by
 * delegating to `Event.suppress()`. Delegating would suppress the
 * underlying model and auth events entirely, which also silences the
 * application's OWN listeners on those events — far more than the caller
 * asked for. This flag suppresses exactly this package.
 *
 * Nesting is a no-op on an already-suppressed scope, matching
 * `Event.suppress()`'s stacking behaviour: an inner call cannot
 * accidentally re-enable logging for an outer one.
 */
export function withoutActivityLogs<T>(callback: () => T | Promise<T>): Promise<T> {
  return storage.run(true, async () => callback());
}

/** Whether the current scope has logging suppressed. */
export function activityLogsSuppressed(): boolean {
  return storage.getStore() === true;
}
