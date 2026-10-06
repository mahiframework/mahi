import { Http } from "@mahiframework/http-client";
import type { SocialiteDriver, SocialiteDriverMeta } from "../../socialite-driver.js";
import type { MappedSocialiteUser } from "../../socialite-user.js";
import {
  defaultDriverOptions,
  Oauth2SocialiteDriver,
  type Oauth2DriverContext,
  type Oauth2DriverOptions,
} from "../oauth2-socialite-driver.js";

/**
 * GitHub's user payload.
 *
 * Four fields are required and two are not, which mirrors Socialite's
 * own asymmetry: it reads `id`, `node_id`, `login` and `avatar_url`
 * directly (throwing if absent) but `name` and `email` through
 * `Arr::get` (nullable). A GitHub user may legitimately have no display
 * name, and no public email.
 */
export interface GithubRawUser {
  id: number;
  node_id: string;
  login: string;
  avatar_url: string;
  name?: string | null;
  email?: string | null;
  [key: string]: unknown;
}

/** One entry from `GET /user/emails`. */
interface GithubEmail {
  email?: unknown;
  primary?: unknown;
  verified?: unknown;
}

const EMAIL_SCOPE = "user:email";

/**
 * Sign in with GitHub.
 *
 * Note what is *not* overridden: `scopeSeparator` stays `","`. GitHub
 * accepts comma-separated scopes, and while most OAuth 2.0 providers
 * want spaces, "fixing" this one would be wrong.
 */
export class GithubSocialiteDriver extends Oauth2SocialiteDriver<GithubRawUser> {
  static readonly meta: SocialiteDriverMeta = {
    name: "GitHub",
    website: "https://github.com",
  };

  protected override readonly defaultScopes: readonly string[] = [EMAIL_SCOPE];

  protected meta(): SocialiteDriverMeta {
    return GithubSocialiteDriver.meta;
  }

  protected withOptions(options: Oauth2DriverOptions): SocialiteDriver<GithubRawUser> {
    return new GithubSocialiteDriver(this.context, options);
  }

  protected authUrl(): string {
    return "https://github.com/login/oauth/authorize";
  }

  protected tokenUrl(): string {
    return "https://github.com/login/oauth/access_token";
  }

  /**
   * GitHub authenticates with `Authorization: token <t>`, its legacy
   * scheme, not `Bearer`.
   */
  protected override authenticated(token: string): ReturnType<typeof Http.withToken> {
    return Http.withToken(token, "token")
      .accept("application/vnd.github.v3+json")
      .withUserAgent("Mahi Socialite")
      .timeout(10_000);
  }

  protected async fetchUser(token: string): Promise<GithubRawUser> {
    const response = await this.authenticated(token).get("https://api.github.com/user");

    this.assertUserFetched(response);

    const user = response.json<GithubRawUser>();

    // GitHub's `/user` omits `email` unless the account has a public
    // one, so the primary verified address is a second call — made only
    // when the scope that permits it was requested.
    if (this.getScopes().includes(EMAIL_SCOPE)) {
      return { ...user, email: user.email ?? (await this.fetchEmail(token)) };
    }

    return user;
  }

  /**
   * The primary verified email, or null.
   *
   * Every failure is swallowed, as Socialite does: a user whose email is
   * unreadable is still a successfully authenticated user, and failing
   * the whole login over a nullable field would be worse. Returns null
   * explicitly where Socialite falls off the end of its loop with an
   * implicit one.
   */
  private async fetchEmail(token: string): Promise<string | null> {
    try {
      const response = await this.authenticated(token).get("https://api.github.com/user/emails");

      if (response.failed()) {
        return null;
      }

      const emails = response.json<unknown>();

      if (!Array.isArray(emails)) {
        return null;
      }

      for (const entry of emails as GithubEmail[]) {
        if (entry.primary === true && entry.verified === true && typeof entry.email === "string") {
          return entry.email;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  protected mapUser(raw: GithubRawUser): MappedSocialiteUser {
    return {
      id: String(raw.id),
      nickname: raw.login,
      name: raw.name ?? null,
      email: raw.email ?? null,
      avatar: raw.avatar_url,
    };
  }
}

/** Build a GitHub driver from its configured context. */
export function githubDriver(
  context: Oauth2DriverContext,
  scopes: readonly string[],
  pkce: boolean,
) {
  return new GithubSocialiteDriver(context, defaultDriverOptions({ scopes, pkce }));
}
