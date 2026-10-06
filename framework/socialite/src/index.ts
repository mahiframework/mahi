export { SocialiteManager } from "./socialite-manager.js";

export { SocialiteServiceProvider, SOCIALITE_TOKEN } from "./socialite-service-provider.js";
export { Socialite } from "./socialite-facade.js";

export {
  resolveConfig,
  driverNameFor,
  missingRequiredKeys,
  validateProvider,
} from "./socialite-config.js";
export type {
  SocialiteConfig,
  SocialiteCookieConfig,
  SocialiteProviderConfig,
  ResolvedSocialiteConfig,
  ValidatedProviderConfig,
} from "./socialite-config.js";

export type {
  SocialiteDriver,
  SocialiteDriverMeta,
  AvailableProvider,
} from "./socialite-driver.js";
export type { SocialiteUser, SocialiteToken, MappedSocialiteUser } from "./socialite-user.js";

export { Oauth2SocialiteDriver, defaultDriverOptions } from "./oauth2/oauth2-socialite-driver.js";
export type {
  Oauth2DriverContext,
  Oauth2DriverOptions,
  TokenResponse,
} from "./oauth2/oauth2-socialite-driver.js";

export { BitbucketSocialiteDriver } from "./oauth2/drivers/bitbucket-driver.js";
export type { BitbucketRawUser } from "./oauth2/drivers/bitbucket-driver.js";

export { FacebookSocialiteDriver } from "./oauth2/drivers/facebook-driver.js";
export type { FacebookRawUser } from "./oauth2/drivers/facebook-driver.js";

export { GithubSocialiteDriver } from "./oauth2/drivers/github-driver.js";
export type { GithubRawUser } from "./oauth2/drivers/github-driver.js";

export { GitlabSocialiteDriver } from "./oauth2/drivers/gitlab-driver.js";
export type { GitlabRawUser, GitlabProviderConfig } from "./oauth2/drivers/gitlab-driver.js";

export { GoogleSocialiteDriver } from "./oauth2/drivers/google-driver.js";
export type { GoogleRawUser } from "./oauth2/drivers/google-driver.js";

export { LinkedinSocialiteDriver } from "./oauth2/drivers/linkedin-driver.js";
export type { LinkedinRawUser } from "./oauth2/drivers/linkedin-driver.js";

export { SlackSocialiteDriver, slackTeamId } from "./oauth2/drivers/slack-driver.js";
export type { SlackRawUser } from "./oauth2/drivers/slack-driver.js";

export { TwitchSocialiteDriver } from "./oauth2/drivers/twitch-driver.js";
export type { TwitchRawUser } from "./oauth2/drivers/twitch-driver.js";

export { XSocialiteDriver } from "./oauth2/drivers/x-driver.js";
export type { XRawUser } from "./oauth2/drivers/x-driver.js";

export {
  SocialiteError,
  InvalidStateError,
  MissingAuthorizationCodeError,
  TokenExchangeFailedError,
  UserFetchFailedError,
  MissingDriverConfigError,
  MissingDriverContextError,
  NoDefaultSocialiteDriverError,
  EmptyUserResponseError,
} from "./errors.js";
export type { InvalidStateReason } from "./errors.js";

// The state cookie's primitives are exported because a driver living in
// another package needs them to participate in the same flow — not as a
// general-purpose API. `buildQuery` is here for the same reason: a
// driver overriding `encoding` has to be able to test what it produces.
export {
  queueState,
  pullState,
  assertStateMatches,
  stateCookieName,
  randomToken,
  codeChallenge,
  constantTimeEquals,
} from "./state.js";
export type { SocialiteState, PulledState, StateCookieOptions } from "./state.js";
export { buildQuery } from "./query.js";
export type { QueryEncoding } from "./query.js";

export { socialiteDriverContract } from "./testing/socialite-driver-contract.js";
export type { ContractCase, ContractHarness } from "./testing/socialite-driver-contract.js";
export { fakeSocialiteUser } from "./testing/fake-user.js";
