import { ServiceProvider, type Application } from "@mahiframework/core";
import { SIGNER_TOKEN, type Signer } from "@mahiframework/encryption";
import { URL_GENERATOR_TOKEN, type UrlGenerator } from "@mahiframework/http";
import { MissingDriverConfigError } from "./errors.js";
import {
  driverNameFor,
  resolveConfig,
  validateProvider,
  type ResolvedSocialiteConfig,
  type SocialiteConfig,
  type SocialiteProviderConfig,
  type ValidatedProviderConfig,
} from "./socialite-config.js";
import type { SocialiteDriver, SocialiteDriverMeta } from "./socialite-driver.js";
import { SocialiteManager } from "./socialite-manager.js";
import {
  BitbucketSocialiteDriver,
  type BitbucketRawUser,
} from "./oauth2/drivers/bitbucket-driver.js";
import { FacebookSocialiteDriver, type FacebookRawUser } from "./oauth2/drivers/facebook-driver.js";
import { GithubSocialiteDriver, type GithubRawUser } from "./oauth2/drivers/github-driver.js";
import {
  GitlabSocialiteDriver,
  type GitlabProviderConfig,
  type GitlabRawUser,
} from "./oauth2/drivers/gitlab-driver.js";
import { GoogleSocialiteDriver, type GoogleRawUser } from "./oauth2/drivers/google-driver.js";
import { LinkedinSocialiteDriver, type LinkedinRawUser } from "./oauth2/drivers/linkedin-driver.js";
import { SlackSocialiteDriver, type SlackRawUser } from "./oauth2/drivers/slack-driver.js";
import { TwitchSocialiteDriver, type TwitchRawUser } from "./oauth2/drivers/twitch-driver.js";
import { XSocialiteDriver, type XRawUser } from "./oauth2/drivers/x-driver.js";
import {
  defaultDriverOptions,
  type Oauth2DriverContext,
} from "./oauth2/oauth2-socialite-driver.js";
import { SOCIALITE_TOKEN } from "./tokens.js";

export { SOCIALITE_TOKEN };

/** A built-in driver: its metadata, and how to build one. */
interface BuiltInDriver {
  readonly meta: SocialiteDriverMeta;
  build(context: Oauth2DriverContext, config: SocialiteProviderConfig): SocialiteDriver;
}

/**
 * The drivers this package ships, keyed by driver name.
 *
 * A provider config naming a driver that isn't here is **skipped**, not
 * an error, so a driver package's own `extend(name, ...)` can claim it —
 * the same arrangement `StorageServiceProvider` has with the S3, SFTP
 * and FTP disk drivers.
 */
const BUILT_IN: Record<string, BuiltInDriver> = {
  bitbucket: {
    meta: BitbucketSocialiteDriver.meta,
    build: (context, config) => new BitbucketSocialiteDriver(context, optionsFrom(config)),
  },
  facebook: {
    meta: FacebookSocialiteDriver.meta,
    build: (context, config) => new FacebookSocialiteDriver(context, optionsFrom(config)),
  },
  github: {
    meta: GithubSocialiteDriver.meta,
    build: (context, config) => new GithubSocialiteDriver(context, optionsFrom(config)),
  },
  gitlab: {
    meta: GitlabSocialiteDriver.meta,
    build: (context, config) =>
      new GitlabSocialiteDriver(
        context,
        optionsFrom(config),
        (config as GitlabProviderConfig).host,
      ),
  },
  google: {
    meta: GoogleSocialiteDriver.meta,
    build: (context, config) => new GoogleSocialiteDriver(context, optionsFrom(config)),
  },
  linkedin: {
    meta: LinkedinSocialiteDriver.meta,
    build: (context, config) => new LinkedinSocialiteDriver(context, optionsFrom(config)),
  },
  slack: {
    meta: SlackSocialiteDriver.meta,
    build: (context, config) => new SlackSocialiteDriver(context, optionsFrom(config)),
  },
  twitch: {
    meta: TwitchSocialiteDriver.meta,
    build: (context, config) => new TwitchSocialiteDriver(context, optionsFrom(config)),
  },
  x: {
    meta: XSocialiteDriver.meta,
    build: (context, config) => new XSocialiteDriver(context, optionsFrom(config)),
  },
};

/** The driver options a configured provider implies. */
function optionsFrom(config: SocialiteProviderConfig) {
  return defaultDriverOptions({
    scopes: config.scopes,
    pkce: config.pkce ?? false,
    parameters: config.parameters,
  });
}

/**
 * Binds the `SocialiteManager` and registers a driver for every
 * configured provider it recognises.
 *
 * ## ORDERING
 *
 * - **After `EncryptionServiceProvider`** — `register()` resolves
 *   `SIGNER_TOKEN` to derive the `"socialite"` purpose key, which signs
 *   the OAuth state cookie.
 *
 * Nothing else constrains it. The `redirect` URL is resolved lazily
 * (inside the driver, on first use), so `HttpServiceProvider` may come
 * on either side; and no routes, commands, migrations or listeners are
 * contributed, so there is nothing for a kernel to collect.
 *
 * You cannot enforce any of that; the app's `config/app.ts` decides, and
 * this docstring is the whole mechanism.
 *
 * Config is validated **here**, at registration, rather than when a
 * driver is first resolved. A typo in `.env` should fail at boot, not at
 * 2am when somebody clicks the button. Socialite defers to resolve; this
 * is a deliberate divergence.
 */
export class SocialiteServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(SOCIALITE_TOKEN, (app) => {
      const config = resolveConfig(app.config.get<SocialiteConfig>("socialite") ?? {});
      const signer = app.make<Signer>(SIGNER_TOKEN).for("socialite");
      const manager = new SocialiteManager(app, config);

      for (const [name, provider] of Object.entries(config.providers)) {
        const validated = validateProvider(provider);
        const builtIn = BUILT_IN[driverNameFor(name, provider)];

        // A driver this package does not ship is left for another
        // package's `extend(name, ...)` to claim — the arrangement
        // `StorageServiceProvider` has with the S3, SFTP and FTP disks.
        // Its config is not validated here, because only the package
        // that owns the driver knows what it needs; but the context IS
        // recorded when the shared keys are present, because that
        // package has no way to assemble one itself.
        if (builtIn === undefined) {
          if (validated.ok) {
            manager.provide(name, driverContext(app, name, validated.config, signer, config));
          }

          continue;
        }

        if (!validated.ok) {
          throw new MissingDriverConfigError(name, validated.missing);
        }

        const context = driverContext(app, name, validated.config, signer, config);

        manager.describe(name, builtIn.meta);
        manager.provide(name, context);
        manager.extend(name, () => builtIn.build(context, validated.config));
      }

      return manager;
    });
  }
}

function driverContext(
  app: Application,
  name: string,
  provider: ValidatedProviderConfig,
  signer: Signer,
  config: ResolvedSocialiteConfig,
): Oauth2DriverContext {
  const { redirect } = provider;

  return {
    name,
    clientId: provider.clientId,
    clientSecret: provider.clientSecret,
    signer,
    cookie: config.cookie,
    // Resolved lazily rather than here, so a root-relative `redirect`
    // can go through the URL generator — which `HttpServiceProvider`
    // binds, and which may not be bound yet when this runs.
    resolveRedirectUrl: () => resolveRedirect(app, redirect),
  };
}

/**
 * Turn a configured `redirect` into an absolute URL.
 *
 * A root-relative value goes through the URL generator, matching
 * Socialite's `formatRedirectUrl()`. An already-absolute one is returned
 * unchanged, which is also what `UrlGenerator.to()` would do — but
 * short-circuiting means an app configuring absolute callback URLs needs
 * no URL generator bound at all.
 */
function resolveRedirect(app: Application, redirect: string): string {
  if (!redirect.startsWith("/")) {
    return redirect;
  }

  return app.make<UrlGenerator>(URL_GENERATOR_TOKEN).to(redirect);
}

export type {
  BitbucketRawUser,
  FacebookRawUser,
  GithubRawUser,
  GitlabRawUser,
  GoogleRawUser,
  LinkedinRawUser,
  SlackRawUser,
  TwitchRawUser,
  XRawUser,
};
