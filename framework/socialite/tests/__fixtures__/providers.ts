import type { StubEntry } from "@mahiframework/http-client";
import type { SocialiteConfig } from "../../src/socialite-config.js";

/**
 * Every built-in driver, with the config and HTTP stubs a full
 * redirect → callback → user round trip needs.
 *
 * One table so the contract and the shared behavioural tests run against
 * all of them. A driver added without an entry here is a driver nobody
 * checked, so the suite asserts this table covers `BUILT_IN`.
 */
export interface ProviderFixture {
  /** The provider's config block, minus the shared required keys. */
  readonly config?: Record<string, unknown>;
  /** URL-pattern stubs, including the token endpoint. */
  readonly stubs: Record<string, StubEntry>;
  /** The authorization URL's origin + path. */
  readonly authUrl: string;
  /** The token endpoint, as asserted against `Http.recorded()`. */
  readonly tokenUrl: string;
  /** Scopes requested when config names none. */
  readonly defaultScopes: readonly string[];
  /** How those scopes are joined in the authorization URL. */
  readonly scopeSeparator: string;
  /** What `user()` should resolve to, for the stubs above. */
  readonly expected: {
    readonly id: string;
    readonly nickname: string | null;
    readonly name: string | null;
    readonly email: string | null;
    readonly avatar: string | null;
  };
  /** The provider's display label and site. */
  readonly meta: { readonly name: string; readonly website: string };
  /** True when the driver requires PKCE whatever the config says. */
  readonly requiresPkce?: boolean;
  /** True when client credentials go in an `Authorization: Basic` header. */
  readonly basicAuth?: boolean;
}

const TOKEN = { access_token: "at", scope: "" };

/**
 * Driver names, which double as the config names the tests use.
 *
 * Listed separately from the table so `ProviderName` is a union of
 * literals while `PROVIDERS` keeps the wider `ProviderFixture` type —
 * `satisfies` alone would narrow away the optional `config` field.
 */
export const PROVIDER_NAMES = [
  "bitbucket",
  "facebook",
  "github",
  "gitlab",
  "google",
  "linkedin",
  "slack",
  "twitch",
  "x",
] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export const PROVIDERS: Record<ProviderName, ProviderFixture> = {
  bitbucket: {
    stubs: {
      "bitbucket.org/site/oauth2/access_token": { ...TOKEN, scope: "email" },
      "api.bitbucket.org/2.0/user": {
        uuid: "{abc-123}",
        username: "ada",
        display_name: "Ada Lovelace",
        links: { avatar: { href: "https://bb.test/ada.png" } },
      },
      "api.bitbucket.org/2.0/user/emails": {
        values: [
          { type: "email", email: "other@example.test", is_primary: false, is_confirmed: true },
          { type: "email", email: "ada@example.test", is_primary: true, is_confirmed: true },
        ],
      },
    },
    authUrl: "https://bitbucket.org/site/oauth2/authorize",
    tokenUrl: "https://bitbucket.org/site/oauth2/access_token",
    defaultScopes: ["email"],
    scopeSeparator: " ",
    expected: {
      id: "{abc-123}",
      nickname: "ada",
      name: "Ada Lovelace",
      email: "ada@example.test",
      avatar: "https://bb.test/ada.png",
    },
    meta: { name: "Bitbucket", website: "https://bitbucket.org" },
  },

  facebook: {
    stubs: {
      "graph.facebook.com/v23.0/oauth/access_token": TOKEN,
      "graph.facebook.com/v23.0/me*": {
        id: "10224",
        name: "Ada Lovelace",
        email: "ada@example.test",
        picture: { data: { url: "https://fb.test/ada.png" } },
      },
    },
    authUrl: "https://www.facebook.com/v23.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v23.0/oauth/access_token",
    defaultScopes: ["email"],
    // Not overridden: Facebook accepts comma-separated scopes.
    scopeSeparator: ",",
    expected: {
      id: "10224",
      nickname: null,
      name: "Ada Lovelace",
      email: "ada@example.test",
      avatar: "https://fb.test/ada.png",
    },
    meta: { name: "Facebook", website: "https://facebook.com" },
  },

  github: {
    stubs: {
      "github.com/login/oauth/access_token": { ...TOKEN, scope: "user:email" },
      "api.github.com/user": {
        id: 1234,
        node_id: "MDQ6",
        login: "ada",
        avatar_url: "https://gh.test/ada.png",
        name: "Ada Lovelace",
      },
      "api.github.com/user/emails": [{ email: "ada@example.test", primary: true, verified: true }],
    },
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    defaultScopes: ["user:email"],
    scopeSeparator: ",",
    expected: {
      id: "1234",
      nickname: "ada",
      name: "Ada Lovelace",
      email: "ada@example.test",
      avatar: "https://gh.test/ada.png",
    },
    meta: { name: "GitHub", website: "https://github.com" },
  },

  gitlab: {
    stubs: {
      "gitlab.com/oauth/token": TOKEN,
      "gitlab.com/api/v4/user": {
        id: 77,
        username: "ada",
        name: "Ada Lovelace",
        email: "ada@example.test",
        avatar_url: "https://gl.test/ada.png",
      },
    },
    authUrl: "https://gitlab.com/oauth/authorize",
    tokenUrl: "https://gitlab.com/oauth/token",
    defaultScopes: ["read_user"],
    scopeSeparator: " ",
    expected: {
      id: "77",
      nickname: "ada",
      name: "Ada Lovelace",
      email: "ada@example.test",
      avatar: "https://gl.test/ada.png",
    },
    meta: { name: "GitLab", website: "https://gitlab.com" },
  },

  google: {
    stubs: {
      "oauth2.googleapis.com/token": TOKEN,
      "openidconnect.googleapis.com/v1/userinfo": {
        sub: "110248495921238986420",
        name: "Grace Hopper",
        given_name: "Grace",
        email: "grace@example.test",
        picture: "https://lh3.test/grace.png",
      },
    },
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    defaultScopes: ["openid", "profile", "email"],
    scopeSeparator: " ",
    expected: {
      id: "110248495921238986420",
      nickname: "Grace",
      name: "Grace Hopper",
      email: "grace@example.test",
      avatar: "https://lh3.test/grace.png",
    },
    meta: { name: "Google", website: "https://google.com" },
  },

  linkedin: {
    stubs: {
      "www.linkedin.com/oauth/v2/accessToken": TOKEN,
      "api.linkedin.com/v2/userinfo": {
        sub: "ABC123",
        name: "Ada Lovelace",
        given_name: "Ada",
        family_name: "Lovelace",
        email: "ada@example.test",
        picture: "https://li.test/ada.png",
      },
    },
    authUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    defaultScopes: ["openid", "profile", "email"],
    scopeSeparator: " ",
    expected: {
      id: "ABC123",
      nickname: null,
      name: "Ada Lovelace",
      email: "ada@example.test",
      avatar: "https://li.test/ada.png",
    },
    meta: { name: "LinkedIn", website: "https://linkedin.com" },
  },

  slack: {
    stubs: {
      "slack.com/api/openid.connect.token": TOKEN,
      "slack.com/api/openid.connect.userInfo": {
        sub: "U123",
        name: "Ada Lovelace",
        email: "ada@example.test",
        picture: "https://slack.test/ada.png",
        "https://slack.com/team_id": "T456",
      },
    },
    authUrl: "https://slack.com/openid/connect/authorize",
    tokenUrl: "https://slack.com/api/openid.connect.token",
    defaultScopes: ["openid", "email", "profile"],
    scopeSeparator: " ",
    expected: {
      id: "U123",
      nickname: null,
      name: "Ada Lovelace",
      email: "ada@example.test",
      avatar: "https://slack.test/ada.png",
    },
    meta: { name: "Slack", website: "https://slack.com" },
  },

  twitch: {
    stubs: {
      "id.twitch.tv/oauth2/token": { access_token: "at", scope: ["user:read:email"] },
      "api.twitch.tv/helix/users": {
        data: [
          {
            id: "44322889",
            login: "ada",
            display_name: "Ada",
            email: "ada@example.test",
            profile_image_url: "https://tw.test/ada.png",
          },
        ],
      },
    },
    authUrl: "https://id.twitch.tv/oauth2/authorize",
    tokenUrl: "https://id.twitch.tv/oauth2/token",
    defaultScopes: ["user:read:email"],
    scopeSeparator: " ",
    expected: {
      id: "44322889",
      nickname: "ada",
      name: "Ada",
      email: "ada@example.test",
      avatar: "https://tw.test/ada.png",
    },
    meta: { name: "Twitch", website: "https://twitch.tv" },
  },

  x: {
    stubs: {
      "api.x.com/2/oauth2/token": TOKEN,
      "api.x.com/2/users/me*": {
        data: {
          id: "2244994945",
          username: "ada",
          name: "Ada Lovelace",
          confirmed_email: "ada@example.test",
          profile_image_url: "https://x.test/ada.png",
        },
      },
    },
    authUrl: "https://x.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    defaultScopes: ["users.read", "users.email", "tweet.read"],
    scopeSeparator: " ",
    expected: {
      id: "2244994945",
      nickname: "ada",
      name: "Ada Lovelace",
      email: "ada@example.test",
      avatar: "https://x.test/ada.png",
    },
    meta: { name: "X", website: "https://x.com" },
    requiresPkce: true,
    basicAuth: true,
  },
};

/** A single-provider config for `createHarness()`. */
export function configFor(name: ProviderName): SocialiteConfig {
  return {
    providers: {
      [name]: {
        clientId: `${name}-id`,
        clientSecret: `${name}-secret`,
        redirect: `https://app.test/auth/${name}/callback`,
        ...PROVIDERS[name].config,
      },
    },
    cookie: { secure: false },
  };
}
