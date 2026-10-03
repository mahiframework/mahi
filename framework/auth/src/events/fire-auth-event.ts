import { EVENTS_TOKEN, app as currentApp, type Application } from "@mahiframework/core";
import type { EventDispatcher } from "@mahiframework/events";
import type { AuthEvent } from "./auth-event.js";

/**
 * Dispatch an auth event, if an event dispatcher is bound.
 *
 * ## Errors propagate
 *
 * This does not catch. A listener that throws fails the auth operation
 * that dispatched the event, matching `@mahiframework/database`'s model
 * events and diverging from `@mahiframework/queue`'s `fireJobEvent()`,
 * which swallows so a crashing observer cannot turn a successful job into
 * a failed one.
 *
 * The divergence is the point. A queue worker that loses an observer has
 * lost telemetry; an authentication subsystem that loses an audit write
 * has lost the record of a security-relevant act, and in a regime where
 * that record is mandatory, continuing as though nothing happened is the
 * worse failure. Propagating also lets a listener refuse an action, which
 * is the only mechanism by which, say, a lockout policy implemented in
 * application code can stop a login.
 *
 * The cost is equally real and the docs say so: an unhandled error in any
 * auth listener is an authentication outage. Listeners here are expected
 * to be careful in a way listeners elsewhere are not.
 *
 * ## Why the dispatcher is resolved per call
 *
 * `has()`/`make()` on every dispatch, rather than a cached dispatcher,
 * because `@mahiframework/testing` swaps the `EVENTS_TOKEN` singleton for
 * a `RecordingEventDispatcher` when `createTestApplication({ fakeEvents:
 * true })` is used. A reference captured at construction would keep
 * pointing at the real dispatcher and every `assertDispatched()` would
 * fail. The container lookup is a `Map` read.
 *
 * ## Why `app` is optional
 *
 * Guards and brokers are constructed by factories that do not receive the
 * `Application` (`SessionGuard` takes a user provider, a session store and
 * a signer; `PasswordBroker` takes a provider, a hasher and config).
 * Threading `app` into all of them to reach the container would widen
 * four constructors and every call site that builds them, including
 * application code that constructs a guard directly.
 *
 * So the ambient `app()` is used when no instance is passed. That helper
 * throws when no application is current, which is a legitimate state in a
 * unit test that constructs a guard with no `Application` at all, so the
 * lookup is guarded and a missing application means "no dispatcher",
 * exactly like an unbound `EVENTS_TOKEN`. An auth operation must not fail
 * because nobody is listening.
 */
export async function fireAuthEvent(event: AuthEvent, app?: Application): Promise<void> {
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
 * optional for the one caller that genuinely treats "no application" as a
 * normal condition.
 */
function resolveApp(): Application | undefined {
  try {
    return currentApp();
  } catch {
    return undefined;
  }
}

/**
 * A copy of `credentials` with secret-bearing keys removed, for an event
 * that reports an attempt without carrying the password.
 *
 * Denylist, not an allowlist of safe keys. An allowlist would silently
 * drop a custom identifying column (`username`, `employee_number`) and
 * make `Attempted` useless for the application that chose it, whereas the
 * secret-bearing names are a short, closed, well-known set. The identifier
 * is the field a listener needs; the secret is the one it must never see.
 *
 * `password_confirmation` is included because a form request's validated
 * output carries it and it holds the same plaintext.
 */
const SECRET_KEYS = new Set(["password", "password_confirmation", "secret", "token"]);

export function safeCredentials(credentials: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};

  for (const [key, value] of Object.entries(credentials)) {
    if (!SECRET_KEYS.has(key.toLowerCase())) {
      safe[key] = value;
    }
  }

  return safe;
}
