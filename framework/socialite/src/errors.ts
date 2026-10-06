/**
 * Base class for every error this package throws, so an app can catch
 * the whole family in one `catch` when it would rather render a generic
 * "sign-in failed" than discriminate.
 *
 * Deliberately NOT `extends HttpError`, which is the other convention in
 * this repo (`@mahiframework/impersonation`'s errors render themselves as
 * a 403). These errors have no single correct status: an
 * `InvalidStateError` is a 403 if an attacker forged the callback and a
 * "please try again" if the user left the consent screen open past the
 * cookie's ten minutes, and the package cannot tell which. The app knows
 * what it wants to show, so it decides.
 */
export class SocialiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Why a callback's `state` was not accepted.
 *
 * Carried on the error so a logging hook can tell "somebody is forging
 * callbacks" from "a user came back to a stale tab". Collapsing them into
 * one message would make that distinction a string match.
 */
export type InvalidStateReason =
  /**
   * No state cookie at all. Usually benign: the cookie's ten minutes
   * elapsed, the browser blocked it, or `sameSite` was tightened to
   * `Strict` (which withholds cookies on the cross-site top-level GET an
   * OAuth callback is).
   */
  | "missing"
  /**
   * The cookie was present but its signature did not verify. Tampered,
   * forged, or signed with an app key that has since been rotated out.
   */
  | "unsigned"
  /**
   * The cookie was minted by a different driver. A second concurrent
   * flow in the same browser, or a replayed cookie.
   */
  | "wrong-provider"
  /**
   * The cookie verified but its `state` is not the one the provider sent
   * back. The CSRF case this check exists for.
   */
  | "mismatch";

const STATE_REASONS: Record<InvalidStateReason, string> = {
  missing: "no state cookie was present (it may have expired)",
  unsigned: "the state cookie's signature did not verify",
  "wrong-provider": "the state cookie was issued for a different provider",
  mismatch: "the state did not match the one issued",
};

/** The callback's `state` did not match what `redirect()` issued. */
export class InvalidStateError extends SocialiteError {
  constructor(
    readonly provider: string,
    readonly reason: InvalidStateReason,
  ) {
    super(`Invalid OAuth state for "${provider}": ${STATE_REASONS[reason]}.`);
  }
}

/**
 * The callback carried no `code`.
 *
 * `error` is the provider's own `error` parameter when it sent one, which
 * is how "the user clicked Cancel" (`access_denied`) is distinguished
 * from a malformed request.
 */
export class MissingAuthorizationCodeError extends SocialiteError {
  constructor(
    readonly provider: string,
    readonly error: string | undefined,
    readonly errorDescription: string | undefined,
  ) {
    super(
      error === undefined
        ? `The "${provider}" callback carried no authorization code.`
        : `The "${provider}" callback returned "${error}"${
            errorDescription === undefined ? "" : `: ${errorDescription}`
          }.`,
    );
  }
}

/**
 * The token endpoint refused the code exchange.
 *
 * OAuth providers put the useful part in the body rather than the status
 * (GitHub answers a bad `client_secret` with a 200 and
 * `{"error":"incorrect_client_credentials"}`), so the body's `error` and
 * `error_description` are lifted out here rather than leaving the caller
 * with a bare `RequestFailedError`.
 */
export class TokenExchangeFailedError extends SocialiteError {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly error: string | undefined,
    readonly errorDescription: string | undefined,
  ) {
    super(
      `Failed to exchange the "${provider}" authorization code (HTTP ${status}${
        error === undefined ? "" : `, ${error}`
      })${errorDescription === undefined ? "" : `: ${errorDescription}`}.`,
    );
  }
}

/** The provider's user endpoint failed or returned something unusable. */
export class UserFetchFailedError extends SocialiteError {
  constructor(
    readonly provider: string,
    readonly status: number,
  ) {
    super(`Failed to fetch the "${provider}" user (HTTP ${status}).`);
  }
}

/**
 * The provider answered successfully but carried no user.
 *
 * Distinct from `UserFetchFailedError` because the HTTP call succeeded:
 * Twitch's Helix API answers 200 with an empty `data` array for a token
 * that is valid but resolves to nobody, so no status check can catch it.
 */
export class EmptyUserResponseError extends SocialiteError {
  constructor(readonly provider: string) {
    super(`The "${provider}" provider returned no user for this access token.`);
  }
}

/**
 * A provider is configured without everything it needs.
 *
 * Lists every missing key rather than the first, so a half-filled `.env`
 * is one fix rather than three rounds of boot-fail. Raised at
 * registration time, not on first use: a typo should fail at boot, not
 * when somebody clicks the button.
 */
export class MissingDriverConfigError extends SocialiteError {
  constructor(
    readonly provider: string,
    readonly missing: readonly string[],
  ) {
    super(
      `The "${provider}" socialite provider is missing required configuration: ` +
        `${missing.join(", ")}. Set them in config/socialite.ts.`,
    );
  }
}

/**
 * A driver asked for a context the service provider never recorded.
 *
 * Means the provider is not configured, or is configured without the
 * credentials every OAuth driver needs. A third-party driver package
 * calls `driverContext(name)` from inside its `extend()` factory, so
 * this surfaces at first use rather than at boot.
 */
export class MissingDriverContextError extends SocialiteError {
  constructor(readonly provider: string) {
    super(
      `No driver context is registered for "${provider}". Configure it under ` +
        "`providers` in config/socialite.ts with clientId, clientSecret and redirect.",
    );
  }
}

/**
 * `driver()` was called with no name.
 *
 * There is no default OAuth provider and never will be: a bare
 * `driver()` means the call site lost track of which button the user
 * clicked. Thrown instead of letting `Manager.driver()` look up `""` and
 * report a `DriverNotRegisteredError` naming a driver the app never
 * wrote. Laravel Socialite's manager does the same thing.
 */
export class NoDefaultSocialiteDriverError extends SocialiteError {
  constructor() {
    super(
      "No socialite driver was specified. There is no default provider — " +
        'name one, e.g. Socialite.driver("github").',
    );
  }
}
