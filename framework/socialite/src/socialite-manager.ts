import { Manager, type Application } from "@mahiframework/core";
import { MissingDriverContextError, NoDefaultSocialiteDriverError } from "./errors.js";
import {
  driverNameFor,
  type ResolvedSocialiteConfig,
  type SocialiteProviderConfig,
} from "./socialite-config.js";
import type {
  AvailableProvider,
  SocialiteDriver,
  SocialiteDriverMeta,
} from "./socialite-driver.js";
import type { Oauth2DriverContext } from "./oauth2/oauth2-socialite-driver.js";

/**
 * Resolves an OAuth driver by its configured name.
 *
 * Drivers register through `extend()` from `SocialiteServiceProvider`,
 * exactly as a third-party driver package would — there is no
 * `create{Name}Driver` dispatch, which `Manager`'s own docstring rules
 * out framework-wide.
 *
 * A resolved driver is cached for the process lifetime, which is why
 * `SocialiteDriver` is stateless by contract and its fluent methods are
 * copy-on-write. See that interface.
 */
export class SocialiteManager extends Manager<SocialiteDriver> {
  /** Metadata for configured providers, so a login page needs no driver. */
  private readonly metadata = new Map<string, SocialiteDriverMeta>();

  /** Driver contexts, built by the service provider as it validates config. */
  private readonly contexts = new Map<string, Oauth2DriverContext>();

  constructor(
    app: Application,
    private readonly config: ResolvedSocialiteConfig,
  ) {
    super(app);
  }

  /**
   * Throws. There is no default OAuth provider.
   *
   * `Manager.driver()` would otherwise look up `""` and raise a
   * `DriverNotRegisteredError` naming a driver the app never wrote.
   * `ImageManager` throws from here for the same reason, and Laravel
   * Socialite's manager does too.
   */
  getDefaultDriver(): string {
    throw new NoDefaultSocialiteDriverError();
  }

  /** The configured block for a provider, or undefined. */
  providerConfig(name: string): SocialiteProviderConfig | undefined {
    return this.config.providers[name];
  }

  /** The driver name a configured provider resolves to. */
  driverName(name: string): string | undefined {
    const config = this.config.providers[name];

    return config === undefined ? undefined : driverNameFor(name, config);
  }

  /**
   * Whether a driver is registered under `name`.
   *
   * Registration and availability are separate: a provider the app
   * configured with a driver no installed package supplies is
   * configured but not registered.
   */
  registered(name: string): boolean {
    return this.creators.has(name);
  }

  /** Every configured provider name, registered or not. */
  configured(): string[] {
    return Object.keys(this.config.providers);
  }

  /**
   * Record a provider's label and website, so `available()` can answer
   * without resolving a driver.
   *
   * Called by the service provider as it registers each driver. Kept
   * separate from `extend()` rather than widening it, the way
   * `MailManager.extendTheme()` keeps a parallel registry: metadata and
   * construction are different axes that happen to share an owner.
   */
  describe(name: string, meta: SocialiteDriverMeta): this {
    this.metadata.set(name, meta);

    return this;
  }

  /**
   * Record the credentials, signer and cookie settings a provider's
   * driver needs.
   *
   * Called by `SocialiteServiceProvider` once it has validated the
   * config. Separate from `extend()` because a driver shipped by another
   * package needs the context *to construct itself*, and that package
   * cannot assemble one — it has no access to the purpose-derived signer
   * or the resolved redirect URL.
   */
  provide(name: string, context: Oauth2DriverContext): this {
    this.contexts.set(name, context);

    return this;
  }

  /**
   * The driver context for a configured provider.
   *
   * The seam a third-party driver package builds against:
   *
   *   socialite.extend("acme", () =>
   *     new AcmeSocialiteDriver(socialite.driverContext("acme"), options));
   */
  driverContext(name: string): Oauth2DriverContext {
    const context = this.contexts.get(name);

    if (context === undefined) {
      throw new MissingDriverContextError(name);
    }

    return context;
  }

  /**
   * Configured, registered providers with their labels — what a
   * "sign in with…" list needs.
   *
   * Resolves nothing: building the list must not construct every driver,
   * and a driver whose config is incomplete would throw if it did.
   */
  available(): readonly AvailableProvider[] {
    const providers: AvailableProvider[] = [];

    for (const name of Object.keys(this.config.providers)) {
      const meta = this.metadata.get(name);

      if (meta === undefined || !this.registered(name)) {
        continue;
      }

      providers.push({ driver: name, name: meta.name, website: meta.website });
    }

    return providers;
  }
}
