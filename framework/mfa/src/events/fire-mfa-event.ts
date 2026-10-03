import { EVENTS_TOKEN, app as currentApp, type Application } from "@mahiframework/core";
import type { EventDispatcher } from "@mahiframework/events";
import type { MfaEvent } from "./mfa-event.js";

/**
 * Dispatch an MFA event, if an event dispatcher is bound.
 *
 * ## Errors propagate
 *
 * This does not catch. A listener that throws fails the MFA operation
 * that dispatched it, matching `@mahiframework/auth`'s `fireAuthEvent()`
 * and `@mahiframework/database`'s model events, and diverging from
 * `@mahiframework/queue`'s job events, which swallow.
 *
 * MFA is an authentication subsystem and is held to authentication's
 * standard: a listener can refuse an action by throwing, and a listener
 * that cannot record a second-factor event stops the act it failed to
 * record. The cost, which the docs state, is that an unhandled error in
 * any MFA listener breaks enrollment or verification, so a listener doing
 * anything failure-prone must catch its own errors.
 *
 * ## Why the dispatcher is resolved per call
 *
 * `has()`/`make()` on every dispatch, rather than a cached reference,
 * because `@mahiframework/testing` swaps the `EVENTS_TOKEN` singleton for
 * a recording dispatcher. A reference captured at construction would keep
 * pointing at the real one and every assertion would fail. The container
 * lookup is a `Map` read.
 *
 * ## Why `app` is optional
 *
 * `MfaManager` has an `Application` and passes it. The three drivers do
 * not: `TotpDriver` takes an `Encrypter`, `EmailDriver` a `Hasher` and a
 * `Signer`, `RecoveryDriver` only its config, and the provider's
 * factories construct them that way. Threading `app` into all three would
 * widen every constructor and every call site that builds one, including
 * application code registering its own driver.
 *
 * So the ambient `app()` is the fallback. That helper throws when no
 * application is current, which is a legitimate state for a driver
 * constructed bare in a unit test, so the lookup is guarded and "no
 * application" means "no dispatcher" exactly as an unbound
 * `EVENTS_TOKEN` does. An MFA operation must not fail because nobody is
 * listening.
 */
export async function fireMfaEvent(event: MfaEvent, app?: Application): Promise<void> {
  const container = app ?? resolveApp();

  if (container === undefined || !container.has(EVENTS_TOKEN)) {
    return;
  }

  await container.make<EventDispatcher>(EVENTS_TOKEN).dispatch(event);
}

/**
 * The current application, or undefined when there is none.
 *
 * `app()` throws rather than returning undefined (deliberately: it is an
 * escape hatch whose misuse should be loud), so this narrows it to an
 * optional for the one caller that treats "no application" as normal.
 */
function resolveApp(): Application | undefined {
  try {
    return currentApp();
  } catch {
    return undefined;
  }
}
