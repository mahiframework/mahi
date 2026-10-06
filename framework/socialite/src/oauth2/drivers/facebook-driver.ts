import { createHmac } from "node:crypto";
import type { SocialiteDriver, SocialiteDriverMeta } from "../../socialite-driver.js";
import type { MappedSocialiteUser } from "../../socialite-user.js";
import { Oauth2SocialiteDriver, type Oauth2DriverOptions } from "../oauth2-socialite-driver.js";

export interface FacebookRawUser {
  id: string;
  name?: string | null;
  email?: string | null;
  link?: string | null;
  picture?: { data?: { url?: string | null } | null } | null;
  [key: string]: unknown;
}

/** The Graph API version this driver targets. */
const GRAPH_VERSION = "v23.0";
const GRAPH_URL = "https://graph.facebook.com";

/** Fields requested from `/me`. Graph returns only what you ask for. */
const FIELDS = ["name", "email", "link", "picture.width(1920)"];

/**
 * Sign in with Facebook.
 *
 * Deliberately **not** a port of Socialite's `id_token` path. Its
 * `getUserByOIDCToken()` decodes a Limited-Login JWT, which needs a JWKS
 * fetch, RSA key reconstruction and nonce tracking — i.e. the whole
 * apparatus `@mahiframework/socialite-oidc` exists for, for one
 * provider's optional mobile flow. This driver does the ordinary
 * server-side authorization-code flow and reads `/me`.
 */
export class FacebookSocialiteDriver extends Oauth2SocialiteDriver<FacebookRawUser> {
  static readonly meta: SocialiteDriverMeta = {
    name: "Facebook",
    website: "https://facebook.com",
  };

  // Not overridden to `" "`: Facebook takes comma-separated scopes.
  protected override readonly defaultScopes: readonly string[] = ["email"];

  protected meta(): SocialiteDriverMeta {
    return FacebookSocialiteDriver.meta;
  }

  protected withOptions(options: Oauth2DriverOptions): SocialiteDriver<FacebookRawUser> {
    return new FacebookSocialiteDriver(this.context, options);
  }

  protected authUrl(): string {
    return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
  }

  protected tokenUrl(): string {
    return `${GRAPH_URL}/${GRAPH_VERSION}/oauth/access_token`;
  }

  protected async fetchUser(token: string): Promise<FacebookRawUser> {
    const response = await this.authenticated(token).get(`${GRAPH_URL}/${GRAPH_VERSION}/me`, {
      fields: FIELDS.join(","),
      // Proves the call came from the app that holds the secret, not
      // merely from someone who captured a token. Graph will reject a
      // mismatched proof when the app has the setting enforced.
      appsecret_proof: createHmac("sha256", this.context.clientSecret).update(token).digest("hex"),
    });

    this.assertUserFetched(response);

    return response.json<FacebookRawUser>();
  }

  protected mapUser(raw: FacebookRawUser): MappedSocialiteUser {
    return {
      id: raw.id,
      // Graph exposes no username on `/me`; Socialite hardcodes null too.
      nickname: null,
      name: raw.name ?? null,
      email: raw.email ?? null,
      avatar: raw.picture?.data?.url ?? null,
    };
  }
}
