/**
 * The `ActivityLogger` singleton.
 *
 * Package-private rather than hoisted into `@mahiframework/core`'s
 * well-known tokens: nothing outside this package resolves it by string,
 * which is the stated bar for living there. A separate module from the
 * provider so the facade can import the token without importing the
 * provider, which would be a cycle.
 */
export const ACTIVITY_LOG_TOKEN = "activity-logs";
