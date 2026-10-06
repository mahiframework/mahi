export { OidcSocialiteDriver, resolveOidcConfig } from "./oidc-socialite-driver.js";
export type {
  OidcProviderConfig,
  OidcRawUser,
  OidcCaches,
  ResolvedOidcConfig,
} from "./oidc-socialite-driver.js";

export {
  SocialiteOidcServiceProvider,
  isOidcProviderConfig,
} from "./socialite-oidc-service-provider.js";

export { DiscoveryCache, fetchDiscovery, discoveryUrl, issuerMatches } from "./discovery.js";
export type { OidcDiscoveryDocument } from "./discovery.js";

export {
  DiscoveryFailedError,
  IdTokenInvalidError,
  SubjectMismatchError,
  EndpointUnsupportedError,
} from "./errors.js";
export type { IdTokenInvalidReason } from "./errors.js";
