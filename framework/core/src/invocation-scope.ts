import type { Application } from "./application.js";
import { Invocation } from "./invocation.js";

/**
 * The context key every log line carries the invocation id under. See
 * `runInvocationScope()`.
 */
export const INVOCATION_CONTEXT_KEY = "invocation";

/**
 * Run one unit of work — an HTTP request, a queue job, a CLI command —
 * as a single isolated invocation, and make its id visible to every log
 * line it produces.
 *
 * Three scopes are opened together, outermost first, because they are
 * three halves of the same idea (per-invocation isolation) and an entry
 * point that opens one without the others gets a subtly broken version
 * of it:
 *
 *   1. the INVOCATION id holder, so `Invocation.id()` is stable within
 *      this unit of work and cannot be reset by a concurrent one;
 *   2. the `ContextRepository` overlay, so context added by this
 *      invocation (the invocation id below, a current user, a job name)
 *      is discarded when it ends rather than accumulating in the
 *      process-global store for the life of the worker;
 *   3. the CONTAINER resolution scope, so `scoped()` bindings resolve
 *      once per invocation instead of behaving as transients.
 *
 * The id is then generated and written into the context overlay, which
 * is what puts `{"invocation":"01a11521-ebe0-71f6-…"}` on every line
 * `formatLogLine()` renders for the rest of this unit of work — with no
 * log call site passing anything. It is generated eagerly here, rather
 * than left to the first `Invocation.id()` caller, precisely so that the
 * FIRST log line of a request carries it too; a lazily-populated context
 * key would be absent from exactly the early lines most worth
 * correlating. Generation is a single `randomUUIDv7()` call (~80ns), so
 * this costs nothing per invocation.
 */
export function runInvocationScope<T>(app: Application, fn: () => T): T {
  return Invocation.runScoped(() =>
    app.context.runScoped(() =>
      app.runScoped(() => {
        app.context.add(INVOCATION_CONTEXT_KEY, Invocation.id());

        return fn();
      }),
    ),
  );
}
