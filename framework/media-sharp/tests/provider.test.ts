import { describe, expect, it } from "vitest";
import { Application } from "@mahiframework/core";
import {
  IMAGE_TOKEN,
  ImageManager,
  MediaServiceProvider,
  NoImageDriverError,
  type MediaConfig,
} from "@mahiframework/media";
import { MediaSharpServiceProvider } from "../src/media-sharp-service-provider.js";
import { SharpImageDriver, type SharpConfig } from "../src/sharp-image-driver.js";

/**
 * Boot an application with the two providers in a given order.
 *
 * `media` needs a database, storage and snowflake for its own manager,
 * but NOT for `IMAGE_TOKEN` — which is bound unconditionally, precisely
 * so a driver package can extend it. So `register()` is called directly
 * rather than going through `app.bootstrap()`: the image seam is what is
 * under test, and standing up SQLite to assert it would test the harness.
 */
async function boot(
  order: "media-first" | "sharp-first",
  config: MediaConfig & { sharp?: SharpConfig } = { image: { default: "sharp" } },
): Promise<Application> {
  const app = new Application();
  app.config.set("media", config);

  const media = new MediaServiceProvider(app);
  const sharp = new MediaSharpServiceProvider(app);

  // EVERY provider's `register()` runs before ANY provider's `boot()`.
  // That is the lifecycle guarantee this provider relies on, so the
  // harness has to honour it rather than registering and booting each
  // provider in turn.
  const providers = order === "media-first" ? [media, sharp] : [sharp, media];

  for (const provider of providers) {
    await provider.register?.();
  }

  for (const provider of providers) {
    await provider.boot?.();
  }

  return app;
}

describe("MediaSharpServiceProvider", () => {
  /**
   * THE TRAP THIS PACKAGE HAS AND THE STORAGE DRIVERS DO NOT.
   *
   * `StorageManager` ships in the same package as its default driver, so
   * a `storage-s3` provider listed before `storage` is already a
   * misconfiguration and resolving the token from `register()` is fine.
   * Here both packages are optional and either order reads naturally, so
   * registration happens in `boot()` — by which point every
   * `register()` has run and `IMAGE_TOKEN` is bound whichever way the
   * two are listed.
   */
  it.each(["media-first", "sharp-first"] as const)(
    "registers the driver with the providers listed %s",
    async (order) => {
      const app = await boot(order);
      const images = app.make<ImageManager>(IMAGE_TOKEN);

      expect(images.registered("sharp")).toBe(true);
      expect(images.configured()).toBe(true);
      expect(images.driver()).toBeInstanceOf(SharpImageDriver);
    },
  );

  it("resolves as the default driver when config names it", async () => {
    const app = await boot("media-first");
    const images = app.make<ImageManager>(IMAGE_TOKEN);

    expect(images.defaultName()).toBe("sharp");
    expect(images.driver("sharp")).toBe(images.driver());
  });

  it("registers the driver even when config names a different one", async () => {
    // Registration and selection are separate. An app may install this
    // package, list the provider, and point `media.image.default`
    // somewhere else — the name stays available under `driver("sharp")`.
    const app = await boot("media-first", { image: { default: "something-else" } });
    const images = app.make<ImageManager>(IMAGE_TOKEN);

    expect(images.registered("sharp")).toBe(true);
    expect(images.driver("sharp")).toBeInstanceOf(SharpImageDriver);
  });

  it("leaves an app that configures no driver with media's own error", async () => {
    // The three-layer story: no driver configured is `media`'s to
    // report, not this package's. Listing the provider registers the
    // name; it does not elect it.
    const app = await boot("media-first", {});
    const images = app.make<ImageManager>(IMAGE_TOKEN);

    expect(images.registered("sharp")).toBe(true);
    expect(images.configured()).toBe(false);
    expect(() => images.driver()).toThrow(NoImageDriverError);
  });

  it("builds nothing until a driver is actually resolved", async () => {
    // Registration is a factory, not a construction. An app that lists
    // the provider and never transforms an image pays for the provider
    // and nothing else — the same property the storage drivers assert
    // about their 18 MB SDK.
    const app = await boot("media-first");
    const images = app.make<ImageManager>(IMAGE_TOKEN);

    expect(images.isResolved("sharp")).toBe(false);

    images.driver("sharp");

    expect(images.isResolved("sharp")).toBe(true);
  });

  it("passes media.sharp config through to the driver", async () => {
    // The observable proof that config is read: a 1-megapixel limit
    // rejects a 4-megapixel image, which the default 268-megapixel
    // bound would wave through.
    const app = await boot("media-first", {
      image: { default: "sharp" },
      sharp: { limitInputPixels: 1_000_000 },
    });

    const sharp = (await import("sharp")).default;
    const bomb = await sharp({
      create: { width: 2000, height: 2000, channels: 3, background: "#ff0000" },
    })
      .png()
      .toBuffer();

    const driver = app.make<ImageManager>(IMAGE_TOKEN).driver();

    await expect(driver.read(bomb)).rejects.toThrow(/exceeds pixel limit/i);
  });

  it("reads config at driver-build time, not at boot", async () => {
    // So config set after boot is still honoured — the driver does not
    // exist until something asks for it, and a test tweaking a limit
    // should not have to re-run the provider.
    const app = await boot("media-first", { image: { default: "sharp" } });

    app.config.set("media.sharp", { autoOrient: false } satisfies SharpConfig);

    const driver = app.make<ImageManager>(IMAGE_TOKEN).driver();

    const sharp = (await import("sharp")).default;
    const tagged = await sharp({
      create: { width: 100, height: 60, channels: 3, background: "#ff0000" },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    // 100x60 rather than 60x100: the orientation tag was deliberately
    // ignored, which only happens if the late config was read.
    expect(await driver.dimensions(await driver.read(tagged))).toEqual({
      width: 100,
      height: 60,
    });
  });

  it("teaches MediaConfig about the sharp key", () => {
    // DECLARATION MERGING, asserted at compile time. An app's
    // `config/media.ts` is typed as `MediaConfig`, and without the
    // augmentation in `sharp-image-driver.ts` this object literal is a
    // type error — which is how the documented config block would
    // become undocumentable. `media` cannot declare the key itself
    // without naming a driver it deliberately does not depend on.
    //
    // `satisfies` rather than a cast, so the check is real: a cast would
    // pass even if the augmentation were deleted.
    const config = {
      image: { default: "sharp" },
      sharp: { limitInputPixels: 50_000_000, autoOrient: true, allowAnimated: false },
    } satisfies MediaConfig;

    expect(config.sharp.limitInputPixels).toBe(50_000_000);
  });

  it("defaults to an empty config when media.sharp is absent", async () => {
    const app = await boot("media-first", { image: { default: "sharp" } });
    const driver = app.make<ImageManager>(IMAGE_TOKEN).driver();

    const sharp = (await import("sharp")).default;
    const image = await sharp({
      create: { width: 50, height: 50, channels: 4, background: "#ff0000" },
    })
      .png()
      .toBuffer();

    expect(await driver.dimensions(await driver.read(image))).toEqual({ width: 50, height: 50 });
  });
});
