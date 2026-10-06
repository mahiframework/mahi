import type { SocialiteDriver, SocialiteDriverMeta } from "../../socialite-driver.js";
import type { MappedSocialiteUser } from "../../socialite-user.js";
import { Oauth2SocialiteDriver, type Oauth2DriverOptions } from "../oauth2-socialite-driver.js";

/** Slack's OpenID Connect userinfo claims. */
export interface SlackRawUser {
  sub: string;
  name?: string | null;
  email?: string | null;
  picture?: string | null;
  /**
   * Slack's namespaced team claim. The key is the literal string
   * `https://slack.com/team_id`, dots and slashes included.
   */
  "https://slack.com/team_id"?: string | null;
  [key: string]: unknown;
}

/**
 * Sign in with Slack.
 *
 * This is Slack's **OpenID Connect** sign-in flow
 * (`openid/connect/authorize`), which is what Slack documents for "Sign
 * in with Slack" and what Socialite calls `SlackOpenIdProvider`.
 *
 * Socialite's other `SlackProvider` drives the `oauth/v2/authorize`
 * bot-installation flow, whose `user_scope`/`scope` split and
 * `authed_user` response unwrapping exist to install an app into a
 * workspace rather than to identify a person. That is a different
 * feature from "log this user in", and not what this package is for.
 *
 * Note that despite the `openid` scope this is **not** an OIDC driver:
 * the `id_token` is ignored and identity comes from the userinfo
 * endpoint. That is sound because the issuer is a hardcoded constant
 * here, so there is no issuer-substitution surface. See
 * `@mahiframework/socialite-oidc` for the generic case.
 */
export class SlackSocialiteDriver extends Oauth2SocialiteDriver<SlackRawUser> {
  static readonly meta: SocialiteDriverMeta = {
    name: "Slack",
    website: "https://slack.com",
  };

  protected override readonly scopeSeparator = " ";
  protected override readonly defaultScopes: readonly string[] = ["openid", "email", "profile"];

  protected meta(): SocialiteDriverMeta {
    return SlackSocialiteDriver.meta;
  }

  protected withOptions(options: Oauth2DriverOptions): SocialiteDriver<SlackRawUser> {
    return new SlackSocialiteDriver(this.context, options);
  }

  protected authUrl(): string {
    return "https://slack.com/openid/connect/authorize";
  }

  protected tokenUrl(): string {
    return "https://slack.com/api/openid.connect.token";
  }

  protected async fetchUser(token: string): Promise<SlackRawUser> {
    const response = await this.authenticated(token).get(
      "https://slack.com/api/openid.connect.userInfo",
    );

    this.assertUserFetched(response);

    return response.json<SlackRawUser>();
  }

  protected mapUser(raw: SlackRawUser): MappedSocialiteUser {
    return {
      id: raw.sub,
      nickname: null,
      name: raw.name ?? null,
      email: raw.email ?? null,
      avatar: raw.picture ?? null,
    };
  }
}

/**
 * The workspace a Slack user signed in from.
 *
 * A helper rather than a field on `SocialiteUser`, because "which
 * tenant" is Slack-specific and does not generalise. Reads the
 * namespaced claim by exact key — do not treat it as a dotted path.
 */
export function slackTeamId(raw: SlackRawUser): string | null {
  return raw["https://slack.com/team_id"] ?? null;
}
