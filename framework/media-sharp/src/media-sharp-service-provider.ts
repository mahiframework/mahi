import { ServiceProvider } from "@mahiframework/core";
import { IMAGE_TOKEN, type ImageManager } from "@mahiframework/media";
import { SharpImageDriver, type SharpConfig } from "./sharp-image-driver.js";

/**
 * Registers the `sharp` image driver on `media`'s `ImageManager`.
 *
 * ```ts
 * // config/media.ts
 * export default {
 *   image: { default: "sharp" },
 *   sharp: { limitInputPixels: 50_000_000 },
 * };
 * ```
 *
 * ## ORDER-INDEPENDENT, deliberately
 *
 * The registration happens in `boot()`, not `register()`, and that is
 * the whole reason this provider may be listed before or after
 * `MediaServiceProvider` in `config/app.ts`.
 *
 * Every provider's `register()` runs before any provider's `boot()`, so
 * by the time this runs, `MediaServiceProvider.register()` has bound
 * `IMAGE_TOKEN` whichever order the two are listed in. Resolving the
 * token from `register()` instead — which is what the storage drivers do
 * — would constrain this provider to be listed second, and unlike the
 * storage case there is no reason to accept that: `StorageManager` lives
 * in the same package as its default driver, so a `storage-s3` listed
 * first is already a misconfiguration. Here both packages are optional
 * and either order reads naturally.
 *
 * A test asserts both orders, because this is the kind of constraint
 * that is invisible until an app happens to list them the other way.
 *
 * ## Registration is not construction
 *
 * The factory is registered; the driver is built on first
 * `images.driver()`, and `sharp` itself — 19 MB and 25 platform
 * packages — is `import()`ed on that driver's first decode. An app that
 * lists this provider and never transforms an image therefore pays for
 * the provider and nothing else.
 */
export class MediaSharpServiceProvider extends ServiceProvider {
  boot(): void {
    const images = this.app.make<ImageManager>(IMAGE_TOKEN);

    images.extend(
      "sharp",
      // Read inside the factory rather than in `boot()`, so config set
      // after boot (a test tweaking `limitInputPixels`, say) is still
      // honoured — the driver is not built until something asks for it.
      (app) => new SharpImageDriver(app.config.get<SharpConfig>("media.sharp") ?? {}),
    );
  }
}
