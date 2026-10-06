import { Http } from "@mahiframework/http-client";
import { EmptyUserResponseError } from "../../errors.js";
import type { SocialiteDriver, SocialiteDriverMeta } from "../../socialite-driver.js";
import type { MappedSocialiteUser } from "../../socialite-user.js";
import { Oauth2SocialiteDriver, type Oauth2DriverOptions } from "../oauth2-socialite-driver.js";

/**
 * Twitch's user object, unwrapped from the `data` array its API returns.
 */
export interface TwitchRawUser {
  id: string;
  login?: string | null;
  display_name?: string | null;
  email?: string | null;
  profile_image_url?: string | null;
  [key: string]: unknown;
}

/** Sign in with Twitch. */
export class TwitchSocialiteDriver extends Oauth2SocialiteDriver<TwitchRawUser> {
  static readonly meta: SocialiteDriverMeta = {
    name: "Twitch",
    website: "https://twitch.tv",
  };

  protected override readonly scopeSeparator = " ";
  protected override readonly defaultScopes: readonly string[] = ["user:read:email"];

  protected meta(): SocialiteDriverMeta {
    return TwitchSocialiteDriver.meta;
  }

  protected withOptions(options: Oauth2DriverOptions): SocialiteDriver<TwitchRawUser> {
    return new TwitchSocialiteDriver(this.context, options);
  }

  protected authUrl(): string {
    return "https://id.twitch.tv/oauth2/authorize";
  }

  protected tokenUrl(): string {
    return "https://id.twitch.tv/oauth2/token";
  }

  /** Twitch requires a `Client-Id` header alongside the bearer token. */
  protected override authenticated(token: string): ReturnType<typeof Http.withToken> {
    return super.authenticated(token).withHeader("Client-Id", this.context.clientId);
  }

  protected async fetchUser(token: string): Promise<TwitchRawUser> {
    const response = await this.authenticated(token).get("https://api.twitch.tv/helix/users");

    this.assertUserFetched(response);

    const users = response.json<{ data?: unknown }>().data;
    const user = Array.isArray(users) ? (users[0] as TwitchRawUser | undefined) : undefined;

    if (user === undefined) {
      // Helix answers 200 with an empty `data` array when the token is
      // valid but resolves to no user, so the status check above cannot
      // catch this.
      throw new EmptyUserResponseError(this.context.name);
    }

    // The inner object, not the wrapper: Socialite also sets `raw` to
    // `data[0]`, and `user.raw.data[0].id` would be a poor API.
    return user;
  }

  protected mapUser(raw: TwitchRawUser): MappedSocialiteUser {
    return {
      id: raw.id,
      // `login` is the canonical handle; `display_name` differs only in
      // capitalisation or script. Socialite uses `display_name` for both
      // fields, which loses the handle entirely.
      nickname: raw.login ?? null,
      name: raw.display_name ?? null,
      email: raw.email ?? null,
      avatar: raw.profile_image_url ?? null,
    };
  }
}
