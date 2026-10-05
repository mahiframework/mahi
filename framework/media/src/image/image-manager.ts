import { Manager, type Application } from "@mahiframework/core";
import { NoImageDriverError } from "../errors.js";
import type { ImageDriver } from "./image-driver.js";

/**
 * Resolves the configured image driver by name.
 *
 * The `gd`-versus-`imagick` split, as a `Manager`: an app names a driver
 * in `media.image.default` and every generic modifier runs through it.
 * Drivers register themselves through `extend()` from their own
 * package's service provider, exactly as a storage driver does.
 *
 *   // config/media.ts
 *   image: { default: "sharp" }
 *
 *   // the driver package's provider
 *   images.extend("sharp", () => new SharpImageDriver());
 *
 * `@mahiframework/media` registers NONE, which is the point. An app that
 * stores documents pays for no image library, and a `Manager` with no
 * drivers is a perfectly good object until something asks for one.
 */
export class ImageManager extends Manager<ImageDriver> {
  constructor(
    app: Application,
    private readonly defaultDriver: string | null,
  ) {
    super(app);
  }

  /**
   * The configured driver name.
   *
   * Throws rather than returning a placeholder when none is configured.
   * `Manager.driver()` would otherwise look up `""` and raise
   * `DriverNotRegisteredError`, whose message is about a driver name the
   * app never wrote — where the real problem is that no image driver is
   * installed at all.
   */
  getDefaultDriver(): string {
    if (this.defaultDriver === null) {
      throw new NoImageDriverError();
    }

    return this.defaultDriver;
  }

  /**
   * Whether an image driver is available.
   *
   * For a caller deciding whether to offer a thumbnail at all, rather
   * than discovering mid-upload that it cannot make one.
   */
  configured(): boolean {
    return this.defaultDriver !== null && this.registered(this.defaultDriver);
  }

  /** Whether a driver has been registered under `name`. */
  registered(name: string): boolean {
    return this.creators.has(name);
  }

  /** The configured driver's name, or null when there is none. */
  defaultName(): string | null {
    return this.defaultDriver;
  }
}
