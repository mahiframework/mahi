import type { SocialiteDriver, SocialiteDriverMeta } from "../../socialite-driver.js";
import type { MappedSocialiteUser } from "../../socialite-user.js";
import { Oauth2SocialiteDriver, type Oauth2DriverOptions } from "../oauth2-socialite-driver.js";

export interface BitbucketRawUser {
  uuid: string;
  username: string;
  display_name?: string | null;
  email?: string | null;
  links?: { avatar?: { href?: string | null } | null } | null;
  [key: string]: unknown;
}

/** One entry from `GET /2.0/user/emails`. */
interface BitbucketEmail {
  type?: unknown;
  email?: unknown;
  is_primary?: unknown;
  is_confirmed?: unknown;
}

const EMAIL_SCOPE = "email";

/** Sign in with Bitbucket. */
export class BitbucketSocialiteDriver extends Oauth2SocialiteDriver<BitbucketRawUser> {
  static readonly meta: SocialiteDriverMeta = {
    name: "Bitbucket",
    website: "https://bitbucket.org",
  };

  protected override readonly scopeSeparator = " ";
  protected override readonly defaultScopes: readonly string[] = [EMAIL_SCOPE];

  protected meta(): SocialiteDriverMeta {
    return BitbucketSocialiteDriver.meta;
  }

  protected withOptions(options: Oauth2DriverOptions): SocialiteDriver<BitbucketRawUser> {
    return new BitbucketSocialiteDriver(this.context, options);
  }

  protected authUrl(): string {
    return "https://bitbucket.org/site/oauth2/authorize";
  }

  protected tokenUrl(): string {
    return "https://bitbucket.org/site/oauth2/access_token";
  }

  protected async fetchUser(token: string): Promise<BitbucketRawUser> {
    const response = await this.authenticated(token).get("https://api.bitbucket.org/2.0/user");

    this.assertUserFetched(response);

    const user = response.json<BitbucketRawUser>();

    // Bitbucket never returns an email on `/user`, so like GitHub it
    // takes a second call — and only when the scope permitting it was
    // requested.
    if (this.getScopes().includes(EMAIL_SCOPE)) {
      return { ...user, email: user.email ?? (await this.fetchEmail(token)) };
    }

    return user;
  }

  /** The primary confirmed email, or null. Never throws. See GitHub. */
  private async fetchEmail(token: string): Promise<string | null> {
    try {
      const response = await this.authenticated(token).get(
        "https://api.bitbucket.org/2.0/user/emails",
      );

      if (response.failed()) {
        return null;
      }

      const values = response.json<{ values?: unknown }>().values;

      if (!Array.isArray(values)) {
        return null;
      }

      for (const entry of values as BitbucketEmail[]) {
        if (
          entry.type === "email" &&
          entry.is_primary === true &&
          entry.is_confirmed === true &&
          typeof entry.email === "string"
        ) {
          return entry.email;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  protected mapUser(raw: BitbucketRawUser): MappedSocialiteUser {
    return {
      id: raw.uuid,
      nickname: raw.username,
      name: raw.display_name ?? null,
      email: raw.email ?? null,
      avatar: raw.links?.avatar?.href ?? null,
    };
  }
}
