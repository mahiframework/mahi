import type { SocialiteDriver, SocialiteDriverMeta } from "../../socialite-driver.js";
import type { MappedSocialiteUser } from "../../socialite-user.js";
import { Oauth2SocialiteDriver, type Oauth2DriverOptions } from "../oauth2-socialite-driver.js";

/** LinkedIn's OpenID Connect userinfo claims. */
export interface LinkedinRawUser {
  sub: string;
  name?: string | null;
  given_name?: string | null;
  family_name?: string | null;
  email?: string | null;
  email_verified?: boolean | null;
  picture?: string | null;
  [key: string]: unknown;
}

/**
 * Sign in with LinkedIn.
 *
 * LinkedIn's **OpenID Connect** flow, which Socialite calls
 * `LinkedInOpenIdProvider`. Its other `LinkedInProvider` requests
 * `r_liteprofile`/`r_emailaddress` and reads `/v2/me` plus
 * `/v2/emailAddress` with projection strings and locale-keyed name
 * lookups — scopes LinkedIn retired in favour of this flow, so porting
 * it would ship a driver that cannot be authorized on a current app.
 *
 * Despite the `openid` scope this is not an OIDC driver; identity comes
 * from userinfo and the hardcoded issuer makes that sound. See
 * `@mahiframework/socialite-oidc`.
 */
export class LinkedinSocialiteDriver extends Oauth2SocialiteDriver<LinkedinRawUser> {
  static readonly meta: SocialiteDriverMeta = {
    name: "LinkedIn",
    website: "https://linkedin.com",
  };

  protected override readonly scopeSeparator = " ";
  protected override readonly defaultScopes: readonly string[] = ["openid", "profile", "email"];

  protected meta(): SocialiteDriverMeta {
    return LinkedinSocialiteDriver.meta;
  }

  protected withOptions(options: Oauth2DriverOptions): SocialiteDriver<LinkedinRawUser> {
    return new LinkedinSocialiteDriver(this.context, options);
  }

  protected authUrl(): string {
    return "https://www.linkedin.com/oauth/v2/authorization";
  }

  protected tokenUrl(): string {
    return "https://www.linkedin.com/oauth/v2/accessToken";
  }

  protected async fetchUser(token: string): Promise<LinkedinRawUser> {
    const response = await this.authenticated(token).get("https://api.linkedin.com/v2/userinfo");

    this.assertUserFetched(response);

    return response.json<LinkedinRawUser>();
  }

  protected mapUser(raw: LinkedinRawUser): MappedSocialiteUser {
    return {
      id: raw.sub,
      // LinkedIn exposes no handle through OIDC; Socialite also maps null.
      nickname: null,
      name: raw.name ?? null,
      email: raw.email ?? null,
      avatar: raw.picture ?? null,
    };
  }
}
