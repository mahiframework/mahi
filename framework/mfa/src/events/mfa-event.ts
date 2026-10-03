import { AbstractEvent } from "@mahiframework/events";

/**
 * Base class for every MFA event.
 *
 * It adds `userId`, which every MFA event has, and nothing else. It
 * exists so an application can observe the whole subsystem with one
 * registration:
 *
 *   events.listen(MfaEvent, RecordSecurityActivity);
 *
 * `EventDispatcher` matches listeners with `instanceof`, so a listener on
 * an abstract base receives every subclass. Prefer that to enumerating
 * the subclasses: an explicit list silently misses whichever event is
 * added next, which for a security log is the failure mode that matters.
 *
 * Every subclass sets `static eventName` to an `"mfa.<Name>"` string. The
 * name is what wildcard patterns (`"mfa.*"`) match on and what keys a
 * queued listener's id, so it must survive a minifier renaming the class.
 *
 * ## No secret, code, or recovery code is ever on an event
 *
 * Four places in this package hold plaintext that must not spread: the
 * TOTP secret at enrollment, the emailed code, a generated recovery code,
 * and whatever the user submitted on a verify. The models defend
 * serialisation with `hidden`, but an event payload bypasses that
 * entirely, and a listener that persists its payload would write the
 * credential to disk. Events here carry ids, driver names and counts.
 */
export abstract class MfaEvent extends AbstractEvent {
  constructor(public readonly userId: string) {
    super();
  }
}
