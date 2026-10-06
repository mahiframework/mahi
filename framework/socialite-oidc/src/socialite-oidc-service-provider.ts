import { ServiceProvider } from "@mahiframework/core";
import {
  defaultDriverOptions,
  driverNameFor,
  MissingDriverConfigError,
  SOCIALITE_TOKEN,
  validateProvider,
  type SocialiteConfig,
  type SocialiteDriver,
  type SocialiteManager,
  type SocialiteProviderConfig,
} from "@mahiframework/socialite";
import {
  OidcSocialiteDriver,
  resolveOidcConfig,
  type OidcCaches,
  type OidcProviderConfig,
} from "./oidc-socialite-driver.js";

/** Whether a provider config is asking for the generic OIDC driver. */
export function isOidcProviderConfig(
  name: string,
  config: SocialiteProviderConfig,
): config is SocialiteProviderConfig & OidcProviderConfig {
  return driverNameFor(name, config) === "oidc";
}

/**
 * Registers the `oidc` driver on `socialite`'s `SocialiteManager`.
 *
 * ## ORDER-INDEPENDENT, deliberately
 *
 * The registration happens in `boot()`, not `register()`, which is the
 * whole reason this provider may be listed before or after
 * `SocialiteServiceProvider` in `config/app.ts`. Every provider's
 * `register()` runs before any provider's `boot()`, so by the time this
 * runs `SOCIALITE_TOKEN` is bound whichever order the two appear in.
 * Resolving the token from `register()` instead — which the storage
 * drivers do — would constrain this provider to be listed second.
 * `MediaSharpServiceProvider` makes the same call.
 *
 * ## Registration is not construction
 *
 * The factory is not invoked until something asks for the driver, and
 * even then no network call happens: discovery is lazy and cached, so an
 * app that configures an OIDC provider it never uses pays nothing.
 */
export class SocialiteOidcServiceProvider extends ServiceProvider {
  boot(): void {
    const socialite = this.app.make<SocialiteManager>(SOCIALITE_TOKEN);
    const config = this.app.config.get<SocialiteConfig>("socialite") ?? {};

    for (const [name, provider] of Object.entries(config.providers ?? {})) {
      if (!isOidcProviderConfig(name, provider)) {
        continue;
      }

      const validated = validateProvider(provider);

      if (!validated.ok) {
        throw new MissingDriverConfigError(name, validated.missing);
      }

      if (typeof provider.issuer !== "string" || provider.issuer === "") {
        throw new MissingDriverConfigError(name, ["issuer"]);
      }

      const oidc = resolveOidcConfig(provider.issuer, provider);

      socialite.describe(name, { name: oidc.label, website: oidc.issuer });

      // One cache holder per configured provider, created here and
      // closed over, so every fluent copy of the driver shares the warm
      // discovery and JWKS caches.
      const caches: OidcCaches = {};

      socialite.extend(name, () => {
        const context = socialite.driverContext(name);

        return new OidcSocialiteDriver(
          context,
          defaultDriverOptions({
            scopes: provider.scopes,
            pkce: true,
            parameters: provider.parameters,
          }),
          oidc,
          caches,
        ) as SocialiteDriver;
      });
    }
  }
}
