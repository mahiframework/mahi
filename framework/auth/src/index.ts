export {
  AuthManager,
  UnknownUserProviderError,
  UserProviderNotRegisteredError,
  GuardNotRegisteredError,
  NotStatefulGuardError,
} from "./auth-manager.js";
export type { AuthConfig, UserProviderFactory } from "./auth-manager.js";

export { AuthServiceProvider, AUTH_TOKEN } from "./auth-service-provider.js";
export { Auth } from "./auth-facade.js";

export {
  runWithAuth,
  currentAuthState,
  requireAuthState,
  user,
  userOrNull,
  check,
  currentGuard,
  MissingAuthContextError,
  UnauthenticatedError,
} from "./auth-context.js";
export type { AuthState } from "./auth-context.js";

export { userKey } from "./user-key.js";

export {
  AuthEvent,
  UserAuthEvent,
  Attempted,
  Authenticated,
  CsrfTokenMismatch,
  CurrentDeviceLogout,
  EmailVerificationSent,
  EmailVerified,
  Failed,
  Login,
  Logout,
  OtherDeviceLogout,
  PasswordReset,
  PasswordResetLinkSent,
  TokenCreated,
  TokenRevoked,
} from "./events/index.js";
export { fireAuthEvent, safeCredentials } from "./events/fire-auth-event.js";

export { isStatefulGuard } from "./guard.js";
export type { Guard, StatefulGuard } from "./guard.js";
export type { Credentials, UserProvider } from "./user-provider.js";

export { DatabaseUserProvider } from "./providers/database-user-provider.js";
export type { DatabaseUserProviderConfig } from "./providers/database-user-provider.js";

export { TokenGuard } from "./guards/token-guard.js";
export type { TokenGuardConfig, NewAccessToken } from "./guards/token-guard.js";
export { hashToken, verifyTokenHash, splitToken } from "./guards/token-hash.js";

export { SessionGuard, LoginUserNotFoundError } from "./guards/session-guard.js";
export type { SessionGuardConfig } from "./guards/session-guard.js";

export { DatabaseSessionStore } from "./session/database-session-store.js";
export { CacheSessionStore } from "./session/cache-session-store.js";
export { ArraySessionStore } from "./session/array-session-store.js";
export type { SessionCacheStore } from "./session/cache-session-store.js";
export type { SessionStore, SessionRecord } from "./session/session-store.js";

export { PersonalAccessToken } from "./models/personal-access-token.js";
export { Session } from "./models/session.js";

export { PasswordBroker } from "./passwords/password-broker.js";
export type {
  PasswordBrokerConfig,
  SendResetLinkResult,
  ResetResult,
  PasswordResetListener,
  CredentialRevoker,
  TokenRevoker,
  RevocationReason,
} from "./passwords/password-broker.js";
export { PasswordResetToken } from "./passwords/password-reset-token.model.js";

export { authenticate, authenticateOptional } from "./middleware/authenticate.js";
export { ensureEmailVerified } from "./middleware/ensure-email-verified.js";
export { csrf } from "./middleware/csrf.js";
export type { CsrfOptions } from "./middleware/csrf.js";

export { hasVerifiedEmail, markEmailAsVerified } from "./verification/email-verification.js";
export type { Verifiable } from "./verification/email-verification.js";
export { EmailVerificationBroker } from "./verification/email-verification-broker.js";
export type {
  EmailVerificationConfig,
  VerificationResult,
  SendVerificationResult,
} from "./verification/email-verification-broker.js";

export { AuthGcCommand } from "./commands/auth-gc.js";
