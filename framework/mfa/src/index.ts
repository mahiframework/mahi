export { MfaManager } from "./mfa-manager.js";
export type { CreateIntentOptions } from "./mfa-manager.js";

export { MfaServiceProvider } from "./mfa-service-provider.js";
export { MFA_TOKEN } from "./tokens.js";
export { Mfa } from "./mfa-facade.js";

export type {
  MfaDriver,
  MfaChallengeContext,
  MfaVerifyContext,
  ChallengeResult,
  VerifyResult,
} from "./mfa-driver.js";

export type {
  MfaConfig,
  WhenUnenrolled,
  TotpDriverConfig,
  EmailDriverConfig,
  RecoveryDriverConfig,
} from "./mfa-config.js";

export { requireMfa, mfaVerified, currentMfaBinding } from "./require-mfa.js";
export type { RequireMfaOptions } from "./require-mfa.js";
export { ensureMfa } from "./middleware/ensure-mfa.js";
export type { EnsureMfaOptions } from "./middleware/ensure-mfa.js";

export { runWithMfa, currentMfaState, requireMfaState } from "./mfa-context.js";
export type { MfaState } from "./mfa-context.js";

export {
  MfaEvent,
  fireMfaEvent,
  ChallengeIssued,
  ChallengeThrottled,
  IntentLocked,
  MethodConfirmed,
  MethodEnrolled,
  RecoveryCodeUsed,
  RecoveryCodesGenerated,
  VerificationFailed,
  Verified,
} from "./events/index.js";

export {
  MfaRequiredError,
  MfaEnrollmentRequiredError,
  MfaLockedError,
  MissingMfaContextError,
  UnknownMfaDriverError,
} from "./errors.js";
export type {
  MfaErrorCode,
  MfaRequiredDetails,
  MfaEnrollmentRequiredDetails,
  MfaLockedDetails,
} from "./errors.js";

export { TotpDriver } from "./drivers/totp-driver.js";
export type { TotpEnrollment } from "./drivers/totp-driver.js";
export { EmailDriver } from "./drivers/email-driver.js";
export { RecoveryDriver } from "./drivers/recovery-driver.js";

export { MfaMethod } from "./models/mfa-method.js";
export type { MfaMethodAttributes } from "./models/mfa-method.js";
export { MfaIntent } from "./models/mfa-intent.js";
export type { MfaIntentAttributes, MfaIntentStatus } from "./models/mfa-intent.js";
export { MfaChallenge } from "./models/mfa-challenge.js";
export type { MfaChallengeAttributes } from "./models/mfa-challenge.js";
export { MfaRecoveryCode } from "./models/mfa-recovery-code.js";
export type { MfaRecoveryCodeAttributes } from "./models/mfa-recovery-code.js";

export { MfaGcCommand } from "./commands/mfa-gc.js";

// TOTP primitives, exported because they are useful independently (an
// app verifying a code outside the driver, a test generating one) and
// because a third-party driver may want them.
export {
  generateSecret,
  generateCode,
  generateCodeForStep,
  verifyCode,
  timestepAt,
} from "./totp/totp.js";
export type {
  TotpAlgorithm,
  TotpOptions,
  TotpVerifyOptions,
  TotpVerifyResult,
} from "./totp/totp.js";
export { otpauthUri } from "./totp/otpauth-uri.js";
export type { OtpauthUriOptions } from "./totp/otpauth-uri.js";
export { encodeBase32, decodeBase32, Base32Error } from "./totp/base32.js";

export { mfaDriverContract } from "./testing/mfa-driver-contract.js";
export type {
  MfaDriverContractCase,
  MfaDriverContractOptions,
} from "./testing/mfa-driver-contract.js";
