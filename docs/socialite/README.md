# Socialite

`@mahiframework/socialite` is OAuth sign-in with third-party providers. A
port of the ideas in `laravel/socialite`, adapted to a framework with no
session bag, whose drivers are cached singletons.

```ts
import { Socialite } from "@mahiframework/socialite";

// GET /auth/github/redirect
return HttpResponse.redirect(await Socialite.driver("github").redirect(request));

// GET /auth/github/callback
const githubUser = await Socialite.driver("github").user(request);

const user = await findOrCreateUser(githubUser);
await Auth.login(request, String(user.id), { guard: "web" });
```

**The package authenticates against the provider and stops there.** It
does not touch your database, does not log anyone in, and ships no
routes. Turning "here is a verified GitHub account" into "this person is
signed in" needs decisions only the app can make — which table holds the
provider id, whether to auto-register, which guard, where to redirect
afterwards — and a framework that guessed all four would be wrong more
often than useful. The controller above is the whole integration.

**Nine providers ship.** The driver seam is the same one a third-party package or your
own app registers through, and the behavioural contract every driver
must satisfy ships with the package — every built-in driver runs it.

| `driver` | Provider | Default scopes |
|---|---|---|
| `bitbucket` | Bitbucket | `email` |
| `facebook` | Facebook | `email` |
| `github` | GitHub | `user:email` |
| `gitlab` | GitLab, incl. self-managed | `read_user` |
| `google` | Google | `openid profile email` |
| `linkedin` | LinkedIn | `openid profile email` |
| `slack` | Slack | `openid email profile` |
| `twitch` | Twitch | `user:read:email` |
| `x` | X (formerly Twitter) | `users.read users.email tweet.read` |

## Not installed by default

```sh
npm install @mahiframework/socialite
```

Then add the provider to `config/app.ts`:

```ts
import { SocialiteServiceProvider } from "@mahiframework/socialite";

export const providers: ServiceProviderClass[] = [
  EventsServiceProvider,
  DatabaseServiceProvider,
  // ...
  EncryptionServiceProvider,
  AuthServiceProvider,
  SocialiteServiceProvider,  // ← here
  // ...
  HttpServiceProvider,

  AppServiceProvider,
];
```

One ordering constraint, and it is real:

- **After `EncryptionServiceProvider`** — `register()` resolves
  `SIGNER_TOKEN` to derive the `"socialite"` signing purpose, which signs
  the OAuth state cookie.

Nothing else. The package contributes no routes, commands, migrations,
models or listeners, and a root-relative `redirect` is resolved lazily on
first use, so `HttpServiceProvider` may come on either side.

## Configuration

```ts
// config/socialite.ts
import type { SocialiteConfig } from "@mahiframework/socialite";
import type { Env } from "./env.js";

export function socialiteConfig(env: Env): SocialiteConfig {
  return {
    providers: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        redirect: "/auth/github/callback",
      },
    },
  };
}
```

| Key | Type | Notes |
|---|---|---|
| `clientId` | `string` | **Required.** |
| `clientSecret` | `string` | **Required.** |
| `redirect` | `string` | **Required.** Absolute, or root-relative and resolved through the URL generator. |
| `driver` | `string?` | Defaults to the config name. |
| `scopes` | `string[]?` | **Replaces** the driver's defaults. See below. |
| `pkce` | `boolean?` | Add PKCE (S256). Off by default. |
| `parameters` | `Record<string, string>?` | Extra authorization-URL parameters. |

Missing a required key is a **boot-time** failure naming every key it is
missing at once, not a failure when somebody clicks the button. Laravel
Socialite validates on resolve; this is a deliberate divergence, on the
grounds that a typo in `.env` should be found by the deploy.

There is deliberately **no `default`**. There is no default OAuth
provider — a bare `Socialite.driver()` means the call site lost track of
which button the user clicked, so it throws.

### Configured `scopes` replace, they do not merge

```ts
github: { scopes: ["repo"] }  // exactly ["repo"], not ["user:email", "repo"]
```

Laravel Socialite merges here, so configuring `["repo"]` on GitHub
silently yields `["user:email", "repo"]`, which surprises people
constantly. The fluent methods keep Socialite's semantics — `.scopes()`
merges, `.setScopes()` replaces — so the explicit call reads how it
behaves.

### Running one driver twice

`providers` is keyed by **config name**; `driver` names the
implementation. Omit it and the name *is* the driver, which is the same
shorthand `auth.guards` uses.

```ts
providers: {
  live:    { driver: "github", clientId: env.GH_LIVE_ID, /* ... */ },
  staging: { driver: "github", clientId: env.GH_STAGING_ID, /* ... */ },
}
```

Both are `GithubSocialiteDriver`; `Socialite.driver("staging")` resolves
the second. An app with two GitHub Apps, or two Keycloak realms, needs
this.

### The state cookie

`redirect()` queues one short-lived signed cookie per provider, carrying
the `state` and, under PKCE, the verifier. `user()` reads it, checks it,
and clears it — single-use, so a replayed callback fails.

```ts
cookie: {
  secure: true,        // default; opt out for plain-HTTP local development
  path: "/",
  ttlSeconds: 600,     // how long a user may sit on the consent screen
  prefix: "host",      // optional: a __Host- cookie
}
```

`SameSite` is **fixed at `Lax`** and is not configurable. The provider
returns the user by a cross-site top-level GET, and `Strict` withholds
cookies on exactly that navigation — so a `Strict` state cookie makes
every login fail with `InvalidStateError`. `Lax` is the correct value
here, and the one footgun worth removing from the config surface.

The cookie is signed with `Signer.for("socialite")`, so a signature
minted by any other consumer of the app key — a signed URL, a session
cookie — will not verify as OAuth state.

See [why this is a cookie and not a session value](../authentication/#there-is-no-session-data-bag).

## The driver

Every method that needs a request takes one. Nothing is stored on the
driver, because `Manager` caches it for the process lifetime and one
instance is shared by every concurrent request.

| Method | Returns | Purpose |
|---|---|---|
| `redirect(request)` | `Promise<string>` | The authorization URL; queues the state cookie. |
| `user(request)` | `Promise<SocialiteUser>` | Verify the callback, exchange the code, fetch the user. |
| `userFromToken(token)` | `Promise<SocialiteUser>` | A user from a token already held. |
| `refreshToken(token)` | `Promise<SocialiteToken>` | Exchange a refresh token. |
| `getName()` | `string` | `"GitHub"`. |
| `getWebsite()` | `string` | `"https://github.com"`. |
| `getScopes()` | `readonly string[]` | Scopes this driver will request. |

`redirect()` returns a **URL**, not a response, so an app can render an
interstitial or hand the URL to a SPA instead of redirecting.

### Fluent methods return a copy

```ts
const driver = Socialite.driver("github");

driver.scopes(["repo"]);        // does nothing — the return value was dropped
const wide = driver.scopes(["repo"]);  // this is the configured driver
```

| Method | Effect |
|---|---|
| `scopes(s)` | Merge into the existing set. |
| `setScopes(s)` | Replace the existing set. |
| `with(params)` | Extra authorization-URL parameters. |
| `redirectUrl(url)` | Override `redirect_uri`. |
| `stateless()` | Issue no `state` and check none. |
| `withPkce()` | Add an S256 challenge. |

This diverges from Laravel Socialite, where these mutate and return
`$this`, and the reason is the singleton: a mutating `scopes(["repo"])`
in one handler would widen the scopes of **every subsequent login in the
process**, which is a privilege-escalation bug no type checker can see.
`PendingRequest` in [`http-client`](../http-client/) is immutable for the
same reason.

`stateless()` removes the callback's CSRF protection and is only
appropriate where the round trip is not browser-mediated.

## The user

```ts
interface SocialiteUser<TRaw = Record<string, unknown>> {
  readonly id: string;
  readonly nickname: string | null;
  readonly name: string | null;
  readonly email: string | null;
  readonly avatar: string | null;
  readonly raw: TRaw;
  readonly token: SocialiteToken;
}

interface SocialiteToken {
  readonly token: string;
  readonly refreshToken: string | null;
  readonly expiresIn: number | null;
  readonly approvedScopes: readonly string[];
}
```

`raw` is the provider's verbatim payload, **typed per driver**:

```ts
const user = await Socialite.driver("github").user(request);

user.raw.node_id;  // string, checked at compile time
```

Four deliberate differences from Laravel Socialite:

- **`id` is always a string.** GitHub returns a number, Google a string;
  normalising at the boundary beats every call site guessing. It is
  unique within its provider and nowhere else, so store it alongside
  which provider it came from.
- **Credentials are nested under `token`.** Socialite puts the same four
  fields on both its user and its `Token` DTO and keeps them in sync by
  hand in two places.
- **No `attributes` bag and no magic getter.** Socialite's `__get` serves
  undeclared keys from a parallel array; a `Proxy` would reproduce it
  exactly and destroy inference, which is most of the reason to be in
  TypeScript. `raw` does the job with types.
- **`approvedScopes` is `[]` when the provider sends no `scope`**, not
  `[""]`. PHP's `explode(",", "")` yields one empty string, and so does
  JS's `"".split(",")`.

## Provider notes

Mostly the drivers are uninteresting — endpoints, a scope list, a field
mapping. These are the exceptions, and each is faithful to the provider
rather than to convention.

### GitHub

- **Scopes are comma-separated.** Most OAuth 2.0 providers want spaces;
  GitHub accepts commas, so the driver does not override the default.
- **The email is a second API call.** `GET /user` omits `email` unless
  the account has a public one, so the driver asks `GET /user/emails`
  for the primary verified address — but only when `user:email` is in
  scope. Every failure of that call yields `email: null` rather than
  failing the login, because a user whose email is unreadable is still
  a successfully authenticated user.
- Authentication uses GitHub's legacy `Authorization: token <t>`
  scheme, not `Bearer`.

### Bitbucket

Same two-call email shape as GitHub, looking for the primary confirmed
address. `id` is Bitbucket's `uuid`, braces included.

### GitLab

Set `host` for a self-managed instance:

```ts
gitlab: {
  host: "https://gitlab.example.com",
  clientId: env.GITLAB_CLIENT_ID,
  // ...
}
```

`getWebsite()` then reports that host, so a login page links to the
right place. The driver reads `/api/v4/user` with a bearer token —
Socialite ports `/api/v3/user` with the token as a query parameter, and
GitLab removed the v3 API in 2018.

### Google

Override `access_type` to get a refresh token, which Google issues only
on first authorization:

```ts
await Socialite.driver("google").with({ access_type: "offline", prompt: "consent" }).redirect(request);
```

`refreshToken()` carries the original refresh token forward when Google
omits a new one, so a second refresh still works.

### X (formerly Twitter)

The most demanding driver, and the one that justifies three of the
base's extension points: **PKCE is mandatory** (X rejects a request
without a `code_challenge`, so it is not an opt-in you can forget),
client credentials go as **HTTP Basic** on the token request, and the
authorization URL uses **RFC 3986** query encoding.

`email` requires the `users.email` scope *and* X's approval of your app;
it is null otherwise.

### Slack and LinkedIn

Both use their provider's **OpenID Connect sign-in** flow, which is what
each documents for "sign in with" and what Socialite calls
`SlackOpenIdProvider` / `LinkedInOpenIdProvider`.

Socialite's other `SlackProvider` drives the bot-installation flow,
whose `user_scope` split and `authed_user` unwrapping exist to install
an app into a workspace rather than to identify a person. Its other
`LinkedInProvider` requests `r_liteprofile`/`r_emailaddress`, which
LinkedIn retired. Neither is ported.

For the Slack workspace a user signed in from:

```ts
import { slackTeamId } from "@mahiframework/socialite";

const team = slackTeamId(user.raw);
```

A helper rather than a field on `SocialiteUser`, because "which tenant"
is Slack-specific and does not generalise.

### Twitch

Requires a `Client-Id` header alongside the bearer token, and returns
its user inside a `data` array — `raw` is the unwrapped object.
`nickname` is Twitch's `login` (the canonical handle) and `name` is
`display_name`; Socialite uses `display_name` for both and loses the
handle.

### Despite the `openid` scope, these are not OIDC drivers

`google`, `slack` and `linkedin` request `openid` but ignore the
`id_token` entirely, taking identity from the userinfo endpoint. That is
sound **because their issuer is a hardcoded constant**: there is no
issuer-substitution surface for `id_token` validation to defend against,
and the code was exchanged directly with that issuer over TLS.

The moment the issuer comes from config, the reasoning collapses — a
generic OIDC driver has to validate the `id_token` in full, and that is
a separate package.

## Errors

Every error extends `SocialiteError`, so an app that would rather render
a generic "sign-in failed" can catch one thing.

| Error | When |
|---|---|
| `InvalidStateError` | The callback's `state` was not accepted. Carries `reason`. |
| `MissingAuthorizationCodeError` | No `code`. Carries the provider's `error`, so `access_denied` is distinguishable. |
| `TokenExchangeFailedError` | The token endpoint refused. Carries `error`/`error_description`. |
| `UserFetchFailedError` | The user endpoint failed. |
| `MissingDriverConfigError` | A provider is missing required keys. Thrown at boot. |
| `NoDefaultSocialiteDriverError` | `driver()` was called with no name. |

These are **not** `HttpError` subclasses, unlike
[`impersonation`](../impersonation/)'s. An `InvalidStateError` is a 403
if somebody forged the callback and a "please try again" if the user sat
on the consent screen past ten minutes, and the package cannot tell
which — so the app chooses the status.

`InvalidStateError.reason` distinguishes four cases, because they mean
different things operationally:

| `reason` | Meaning |
|---|---|
| `missing` | No cookie. Usually benign: expired, or blocked. |
| `unsigned` | Signature failed. Tampered, or an app key rotated out. |
| `wrong-provider` | A cookie minted for a different driver. |
| `mismatch` | Verified, but not the state that was issued. The CSRF case. |

A spike in `mismatch` is worth alerting on; a steady trickle of `missing`
is users with stale tabs.

## Writing a driver

Extend `Oauth2SocialiteDriver` and supply five members:

```ts
export class AcmeSocialiteDriver extends Oauth2SocialiteDriver<AcmeRawUser> {
  static readonly meta = { name: "Acme", website: "https://acme.test" };

  protected override readonly scopeSeparator = " ";
  protected override readonly defaultScopes = ["profile", "email"];

  protected meta() { return AcmeSocialiteDriver.meta; }
  protected authUrl() { return "https://acme.test/oauth/authorize"; }
  protected tokenUrl() { return "https://acme.test/oauth/token"; }

  protected withOptions(options: Oauth2DriverOptions) {
    return new AcmeSocialiteDriver(this.context, options);
  }

  protected async fetchUser(token: string): Promise<AcmeRawUser> {
    const response = await this.authenticated(token).get("https://acme.test/userinfo");
    this.assertUserFetched(response);

    return response.json<AcmeRawUser>();
  }

  protected mapUser(raw: AcmeRawUser): MappedSocialiteUser {
    return {
      id: String(raw.sub),
      nickname: raw.preferred_username ?? null,
      name: raw.name ?? null,
      email: raw.email ?? null,
      avatar: raw.picture ?? null,
    };
  }
}
```

`withOptions()` is abstract so a subclass cannot forget to be immutable —
every fluent method routes through it.

Register it from your own service provider's `boot()`, which makes the
registration order-independent:

```ts
export class AcmeSocialiteServiceProvider extends ServiceProvider {
  boot(): void {
    Socialite.extend("acme", () => new AcmeSocialiteDriver(context, defaultDriverOptions()));
  }
}
```

A provider config naming a driver this package does not ship is
**skipped**, not rejected, so your `extend("acme", ...)` can claim it —
the same arrangement [`storage`](../storage/) has with its disk drivers.

### Run the contract

Satisfying the TypeScript interface is not the same as behaving
correctly: types cannot express "does not mutate itself" or "rejects a
forged state". The contract can.

```ts
import { socialiteDriverContract } from "@mahiframework/socialite";

describe("AcmeSocialiteDriver", () => {
  for (const contractCase of socialiteDriverContract(harness)) {
    it(contractCase.name, () => contractCase.run());
  }
});
```

Fifteen cases, covering the state round trip, single-use cookies, PKCE,
and copy-on-write for every fluent method. The package's own test suite
checks the contract against deliberately broken drivers first — a
contract that cannot fail is decoration.

## Testing

`Socialite` is a facade, so `swap()` replaces it wholesale, and
`fakeSocialiteUser()` builds a user without an OAuth round trip:

```ts
import { Socialite, fakeSocialiteUser } from "@mahiframework/socialite";

Socialite.swap({
  driver: () => ({ user: async () => fakeSocialiteUser({ email: "ada@example.test" }) }),
});

// ...

Socialite.restore();
```

To exercise the real driver instead, fake the provider's HTTP endpoints
with [`Http.fake()`](../http-client/#faking). That is how this package's
own suite runs: 147 tests, zero network, no credentials.

## Related

- [Authentication](../authentication/) — guards, `Auth.login()`, and
  [why there is no session data bag](../authentication/#there-is-no-session-data-bag)
- [HTTP client](../http-client/) — the outbound requests and their fakes
- [Encryption](../encryption/) — `Signer` and purpose derivation
