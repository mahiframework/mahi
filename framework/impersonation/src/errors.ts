import { HttpError } from "@mahiframework/http";

/**
 * Why an impersonation was refused.
 *
 * Carried on the error so a logging hook can tell "an admin attempted
 * something they are not permitted to do" (`not-authorized`, worth
 * alerting on) from "an admin double-clicked a button" (`already-active`,
 * noise). Collapsing them into one 403 with a message would make that
 * distinction a string match.
 */
export type ImpersonationDenialReason =
  /** The app's `authorize()` gate returned false. Also the default, deny-all, answer. */
  | "not-authorized"
  /** The admin and the target are the same user. */
  | "self"
  /** The chain is already `maxDepth` links deep. */
  | "max-depth"
  /** The target is already somewhere in the current chain; impersonating them would loop. */
  | "already-in-chain";

/**
 * Thrown when an impersonation is refused.
 *
 * Extends `HttpError` so it renders as a 403 with no mapping code in the
 * caller, including from a hand-rolled route that never imported this
 * package's error types, while remaining `instanceof`-checkable for an app
 * that wants its own response shape. The same reasoning
 * `ValidationException` and the `Gate`'s denials already follow.
 *
 * Note this is NOT what a `before()` hook throws. Hook errors propagate
 * exactly as thrown, so an MFA hook raising a 401-with-challenge reaches
 * the client as that rather than being flattened into a 403.
 */
export class ImpersonationDeniedError extends HttpError {
  constructor(
    public readonly reason: ImpersonationDenialReason,
    message: string,
  ) {
    super(403, message);
    this.name = "ImpersonationDeniedError";
  }
}

/**
 * Thrown by `stop()` when the impersonator can no longer be logged back
 * in, because the account was deleted (or soft-deleted, which stops it
 * resolving through the user provider) during the impersonation.
 *
 * A 409 rather than a 403: nothing is forbidden, the state is simply
 * irreconcilable. The built-in stop controller catches this, logs the
 * session out entirely rather than leaving someone stranded inside
 * another user's account, and reports it.
 */
export class ImpersonatorMissingError extends HttpError {
  constructor(public readonly impersonatorId: string) {
    super(
      409,
      `The impersonating user "${impersonatorId}" no longer exists, so this ` +
        `impersonation cannot be ended by returning to it.`,
    );
    this.name = "ImpersonatorMissingError";
  }
}
