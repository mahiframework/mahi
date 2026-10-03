import { AsyncLocalStorage } from "node:async_hooks";
import type { Request } from "@mahiframework/http";
import { MissingMfaContextError } from "./errors.js";

/**
 * The per-request MFA scope.
 *
 * This exists because there is no ambient `Request` in this framework.
 * `Auth.user()` works with no arguments because identity lives in
 * `@mahiframework/auth`'s own AsyncLocalStorage scope, seeded by a
 * global pipe; there is no equivalent for the request itself. Reading
 * the user ambiently is therefore fine, but computing the session
 * BINDING needs the request, so this package opens its own scope the
 * same way.
 *
 * The binding is computed once per request, in the provider's pipe,
 * rather than on each `requireMfa()` call: it is a cookie read plus an
 * HMAC verify, and a handler may guard several actions.
 *
 * `request` is carried too, so a caller inside a request never has to
 * thread it through, while a caller outside one (a queue job, a CLI
 * command) passes it explicitly and gets a clear error if they forget.
 */
export interface MfaState {
  /**
   * The session or token id this request belongs to, or null when the
   * active guard exposes no per-request identifier, or binding is off.
   */
  binding: string | null;
  request: Request;
}

const storage = new AsyncLocalStorage<MfaState>();

/** Run `fn` inside an MFA scope. Called once per request by the provider's pipe. */
export function runWithMfa<T>(state: MfaState, fn: () => T): T {
  return storage.run(state, fn);
}

/** The active scope, or null outside one. */
export function currentMfaState(): MfaState | null {
  return storage.getStore() ?? null;
}

/**
 * The active scope, or throw.
 *
 * The throw is the point: see `MissingMfaContextError` for why neither
 * passing nor denying is acceptable here.
 */
export function requireMfaState(): MfaState {
  const state = storage.getStore();

  if (state === undefined) {
    throw new MissingMfaContextError();
  }

  return state;
}
