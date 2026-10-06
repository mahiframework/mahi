import { EmptyUserResponseError } from "../../errors.js";
import type { SocialiteDriver, SocialiteDriverMeta } from "../../socialite-driver.js";
import type { MappedSocialiteUser } from "../../socialite-user.js";
import { Oauth2SocialiteDriver, type Oauth2DriverOptions } from "../oauth2-socialite-driver.js";

/** X's user object, unwrapped from the `data` envelope its API returns. */
export interface XRawUser {
  id: string;
  username?: string | null;
  name?: string | null;
  confirmed_email?: string | null;
  profile_image_url?: string | null;
  [key: string]: unknown;
}

/**
 * Sign in with X (formerly Twitter).
 *
 * The most demanding driver in the package, and the one that justifies
 * three of the base's extension points:
 *
 * - **PKCE is mandatory.** X rejects an authorization request with no
 *   `code_challenge`, so `requiresPkce` is set rather than leaving it to
 *   an app to remember.
 * - **HTTP Basic on the token request.** X wants
 *   `Authorization: Basic base64(id:secret)`, not form credentials.
 * - **RFC 3986 query encoding**, which X requires and which is why
 *   `buildQuery` takes an encoding at all.
 *
 * Only the OAuth 2.0 flow is supported. Socialite still ships an OAuth
 * 1.0a Twitter provider, but its own manager routes to OAuth 2.0 when
 * asked, and OAuth 1.0a is out of scope for this package.
 */
export class XSocialiteDriver extends Oauth2SocialiteDriver<XRawUser> {
  static readonly meta: SocialiteDriverMeta = {
    name: "X",
    website: "https://x.com",
  };

  protected override readonly scopeSeparator = " ";
  protected override readonly defaultScopes: readonly string[] = [
    "users.read",
    "users.email",
    "tweet.read",
  ];

  protected override readonly encoding = "rfc3986" as const;
  protected override readonly requiresPkce = true;
  protected override readonly tokenAuth = "basic" as const;

  protected meta(): SocialiteDriverMeta {
    return XSocialiteDriver.meta;
  }

  protected withOptions(options: Oauth2DriverOptions): SocialiteDriver<XRawUser> {
    return new XSocialiteDriver(this.context, options);
  }

  protected authUrl(): string {
    return "https://x.com/i/oauth2/authorize";
  }

  protected tokenUrl(): string {
    return "https://api.x.com/2/oauth2/token";
  }

  protected async fetchUser(token: string): Promise<XRawUser> {
    const response = await this.authenticated(token).get("https://api.x.com/2/users/me", {
      "user.fields": "profile_image_url,confirmed_email",
    });

    this.assertUserFetched(response);

    const user = response.json<{ data?: XRawUser }>().data;

    if (user === undefined) {
      throw new EmptyUserResponseError(this.context.name);
    }

    // The inner object, matching Socialite — `user.raw.data.id` would be
    // a worse API than `user.raw.id`.
    return user;
  }

  protected mapUser(raw: XRawUser): MappedSocialiteUser {
    return {
      id: raw.id,
      nickname: raw.username ?? null,
      name: raw.name ?? null,
      // Only present with the `users.email` scope, and only once X has
      // approved the app for it.
      email: raw.confirmed_email ?? null,
      avatar: raw.profile_image_url ?? null,
    };
  }
}
