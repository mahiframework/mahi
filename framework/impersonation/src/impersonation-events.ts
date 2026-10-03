import { AbstractEvent } from "@mahiframework/events";
import type { ImpersonationRecord } from "./models/impersonation-link.js";

/**
 * Impersonation lifecycle events, dispatched through
 * `@mahiframework/events` when an `EventsServiceProvider` is registered.
 * An app without one gets working impersonation and no events.
 *
 * Both carry the resolved users as well as the row, because every
 * plausible listener, an audit log, a banner, a Slack notification, wants
 * them, and making each listener re-fetch the same two users would be
 * wasteful. They are typed `unknown`: the framework never knows the app's
 * user class, so a listener narrows with its own generic parameter.
 */
export class ImpersonationStarted extends AbstractEvent {
  constructor(
    public readonly record: ImpersonationRecord,
    public readonly impersonator: unknown,
    public readonly impersonated: unknown,
  ) {
    super();
  }
}

/**
 * Dispatched when an impersonation is ended deliberately, by `stop()`.
 *
 * Deliberately NOT dispatched when one merely lapses. Nothing observes
 * that moment except `impersonation:gc`, and firing a "finished" event
 * from a cron hours later would misreport when it happened and hand
 * listeners a request-less context they can't act in. The gc command
 * reports a count instead, which is the honest surface.
 */
export class ImpersonationFinished extends AbstractEvent {
  constructor(
    public readonly record: ImpersonationRecord,
    public readonly impersonator: unknown,
    public readonly impersonated: unknown,
  ) {
    super();
  }
}
