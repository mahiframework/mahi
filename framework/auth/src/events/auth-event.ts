import { AbstractEvent } from "@mahiframework/events";

/**
 * Base class for every authentication event.
 *
 * It adds no members. It exists so an application can observe the whole
 * subsystem with one registration, which is the thing an audit log, a
 * metrics exporter or an intrusion detector actually wants:
 *
 *   events.listen(AuthEvent, RecordSecurityActivity);
 *
 * `EventDispatcher` matches listeners with `instanceof`
 * (`event-dispatcher.ts`), so a listener registered on a base class
 * receives every subclass. The alternative, enumerating fourteen classes
 * at the call site, silently misses any event added later, which for a
 * security log is the failure mode that matters.
 *
 * Every subclass sets `static eventName` to a `"auth.<Name>"` string.
 * That is not decoration: the name is what wildcard patterns
 * (`events.listen("auth.*", ...)`) match on, and what keys a queued
 * listener's id, so a minifier renaming the class must not change it.
 */
export abstract class AuthEvent extends AbstractEvent {}

/**
 * Base class for events that identify a user by id without necessarily
 * holding the user object.
 *
 * `userId` is a `string` throughout this package even though a model's key
 * may be a `number` or a `bigint` (the scaffolded `User` uses
 * an auto-increment key, a `bigint`). Guards already take and return
 * string ids, so this is the type the subsystem speaks, and a listener
 * writing the value to a polymorphic column needs a string anyway.
 */
export abstract class UserAuthEvent extends AuthEvent {
  constructor(public readonly userId: string) {
    super();
  }
}
