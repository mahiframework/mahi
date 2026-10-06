import type { SocialiteDriver, SocialiteDriverMeta } from "../../socialite-driver.js";
import type { MappedSocialiteUser, SocialiteToken } from "../../socialite-user.js";
import { Oauth2SocialiteDriver, type Oauth2DriverOptions } from "../oauth2-socialite-driver.js";

/**
 * Google's OIDC userinfo payload.
 *
 * `sub` is the only field guaranteed present. Everything else depends on
 * which scopes were granted — `email` needs the `email` scope, `name`
 * and `picture` need `profile` — so all of them are optional.
 */
export interface GoogleRawUser {
  sub: string;
  name?: string | null;
  given_name?: string | null;
  family_name?: string | null;
  nickname?: string | null;
  email?: string | null;
  email_verified?: boolean | null;
  picture?: string | null;
  [key: string]: unknown;
}

/**
 * Sign in with Google.
 *
 * Three things this driver needs that GitHub does not, and between them
 * they exercise every extension point on the base:
 *
 * 1. **A space scope separator.** Google — and every OIDC provider —
 *    rejects the comma-separated list GitHub accepts.
 * 2. **A `refreshToken()` override.** Google omits `refresh_token` from
 *    a refresh response, so the one passed in has to be carried forward
 *    or the caller loses the ability to refresh again.
 * 3. **`Bearer` authentication**, which is the base's default, so
 *    `authenticated()` is *not* overridden here.
 *
 * Deliberately **not** an OIDC driver. Google's `id_token` is ignored
 * entirely and identity comes from the userinfo endpoint, which is what
 * Socialite's own `GoogleProvider` effectively does for a configured
 * `openid` scope. That is sound here because the issuer is a hardcoded
 * constant: there is no issuer-substitution surface for `id_token`
 * validation to defend against. Generic OIDC, where the issuer comes
 * from config, is a different problem and gets its own package.
 */
export class GoogleSocialiteDriver extends Oauth2SocialiteDriver<GoogleRawUser> {
  static readonly meta: SocialiteDriverMeta = {
    name: "Google",
    website: "https://google.com",
  };

  protected override readonly scopeSeparator = " ";

  protected override readonly defaultScopes: readonly string[] = ["openid", "profile", "email"];

  protected meta(): SocialiteDriverMeta {
    return GoogleSocialiteDriver.meta;
  }

  protected withOptions(options: Oauth2DriverOptions): SocialiteDriver<GoogleRawUser> {
    return new GoogleSocialiteDriver(this.context, options);
  }

  protected authUrl(): string {
    return "https://accounts.google.com/o/oauth2/v2/auth";
  }

  /**
   * The current endpoint, not Socialite's dated
   * `www.googleapis.com/oauth2/v4/token`.
   */
  protected tokenUrl(): string {
    return "https://oauth2.googleapis.com/token";
  }

  protected async fetchUser(token: string): Promise<GoogleRawUser> {
    const response = await this.authenticated(token).get(
      "https://openidconnect.googleapis.com/v1/userinfo",
    );

    this.assertUserFetched(response);

    return response.json<GoogleRawUser>();
  }

  /**
   * Carry the old refresh token forward when Google omits a new one.
   *
   * Google issues `refresh_token` only on the first authorization (and
   * only with `access_type=offline`), never on a refresh. Socialite
   * overrides this method for exactly this reason — in PHP it had to,
   * because its `Token` constructor is typed `string` and a null was a
   * TypeError. Here the field is `string | null` so nothing crashes, but
   * reporting `null` would still lose the caller's ability to refresh a
   * second time.
   */
  override async refreshToken(refreshToken: string): Promise<SocialiteToken> {
    const token = await super.refreshToken(refreshToken);

    return token.refreshToken === null ? { ...token, refreshToken } : token;
  }

  protected mapUser(raw: GoogleRawUser): MappedSocialiteUser {
    return {
      id: raw.sub,
      // Google rarely sends `nickname`; `given_name` is the closest
      // thing to a short name it reliably provides.
      nickname: raw.nickname ?? raw.given_name ?? null,
      name: raw.name ?? null,
      email: raw.email ?? null,
      avatar: raw.picture ?? null,
    };
  }
}
