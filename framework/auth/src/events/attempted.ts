import { AuthEvent } from "./auth-event.js";

/**
 * Credentials were verified, successfully or not.
 *
 * Dispatched by `AuthManager.attempt()` for BOTH outcomes, with
 * `succeeded` carrying which. One event for both is deliberate: a rate
 * limiter and an audit log both want every attempt, and splitting them
 * means every such listener registers twice and risks catching only half.
 *
 * `credentials` has the secret stripped, see `safeCredentials()`. The
 * identifying key (`email`, `username`) survives, because "47 attempts
 * against this address" is the entire point of logging a failure.
 *
 * `user` is non-null only on success. On failure it is null even when the
 * account exists, because `attempt()`'s whole design is to not tell its
 * caller the difference (`auth-manager.ts`'s constant-work hash on the
 * miss path). A listener wanting that distinction has to look the address
 * up itself, and should think carefully about whether storing the answer
 * re-creates the enumeration oracle the timing work removed.
 */
export class Attempted extends AuthEvent {
  static override eventName = "auth.Attempted";

  constructor(
    public readonly credentials: Record<string, string>,
    public readonly succeeded: boolean,
    public readonly user: unknown | null = null,
    public readonly guard: string | null = null,
  ) {
    super();
  }
}
