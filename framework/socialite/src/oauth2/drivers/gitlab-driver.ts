import type { SocialiteDriver, SocialiteDriverMeta } from "../../socialite-driver.js";
import type { MappedSocialiteUser } from "../../socialite-user.js";
import {
  Oauth2SocialiteDriver,
  type Oauth2DriverContext,
  type Oauth2DriverOptions,
} from "../oauth2-socialite-driver.js";

export interface GitlabRawUser {
  id: number;
  username: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
  [key: string]: unknown;
}

/** `host` on a `gitlab` provider config, for a self-managed instance. */
export interface GitlabProviderConfig {
  host?: string;
}

const DEFAULT_HOST = "https://gitlab.com";

/**
 * Sign in with GitLab, including a self-managed instance.
 *
 * The first driver whose endpoints are not constants: `host` in config
 * points it at `https://gitlab.example.com`. Socialite does this with a
 * post-construction `setHost()` setter called from the manager, which a
 * copy-on-write driver cannot use — the host belongs in the context,
 * where it survives every fluent copy.
 */
export class GitlabSocialiteDriver extends Oauth2SocialiteDriver<GitlabRawUser> {
  static readonly meta: SocialiteDriverMeta = {
    name: "GitLab",
    website: DEFAULT_HOST,
  };

  protected override readonly scopeSeparator = " ";
  protected override readonly defaultScopes: readonly string[] = ["read_user"];

  private readonly host: string;

  constructor(context: Oauth2DriverContext, options: Oauth2DriverOptions, host?: string) {
    super(context, options);
    this.host = (host ?? DEFAULT_HOST).replace(/\/+$/, "");
  }

  protected meta(): SocialiteDriverMeta {
    // The label stays "GitLab" but the website is the configured
    // instance, so a login page for a self-managed GitLab links there.
    return { name: GitlabSocialiteDriver.meta.name, website: this.host };
  }

  protected withOptions(options: Oauth2DriverOptions): SocialiteDriver<GitlabRawUser> {
    return new GitlabSocialiteDriver(this.context, options, this.host);
  }

  protected authUrl(): string {
    return `${this.host}/oauth/authorize`;
  }

  protected tokenUrl(): string {
    return `${this.host}/oauth/token`;
  }

  protected async fetchUser(token: string): Promise<GitlabRawUser> {
    // v4, not Socialite's v3: GitLab removed the v3 API in 11.0 (2018),
    // so the ported endpoint is a 404 against any supported instance.
    // And a Bearer header rather than Socialite's `?access_token=`,
    // which GitLab deprecated for the same reason RFC 6750 §2.3
    // discourages it — tokens leak into logs and Referer headers.
    const response = await this.authenticated(token).get(`${this.host}/api/v4/user`);

    this.assertUserFetched(response);

    return response.json<GitlabRawUser>();
  }

  protected mapUser(raw: GitlabRawUser): MappedSocialiteUser {
    return {
      id: String(raw.id),
      nickname: raw.username,
      name: raw.name ?? null,
      email: raw.email ?? null,
      avatar: raw.avatar_url ?? null,
    };
  }
}
