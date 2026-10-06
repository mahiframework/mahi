/**
 * `sharp` is an OPTIONAL PEER DEPENDENCY, loaded on first use.
 *
 * It is 19 MB installed and pulls 25 platform-specific optional packages
 * (`@img/sharp-darwin-arm64`, `@img/sharp-libvips-linux-x64`, …). Making
 * it a required dependency would put all of that into every application
 * that installs `@mahiframework/media` for documents, and into CI for
 * every package in this workspace that never decodes an image. Same
 * reasoning as `@mahiframework/storage-s3` and its 18 MB of AWS SDK.
 */

/**
 * The `sharp` factory function, as this package calls it.
 *
 * Typed against `sharp`'s own declarations rather than a hand-written
 * structural subset, so `sharpModifier()` hands callers a fully typed
 * pipeline with every one of libvips' operations on it. That is the
 * entire point of the escape hatch — a narrowed interface would leave it
 * offering `blur()` and nothing else.
 *
 * The `optional` in `peerDependenciesMeta` exists so an app using
 * `@mahiframework/media` for documents does not install 19 MB of native
 * binaries. An app that installs THIS package has installed `sharp`, so
 * the type reference resolves.
 */
export type SharpModule = typeof import("sharp").default;

/** A `sharp` pipeline instance: lazy, and the thing to be careful with. */
export type SharpPipeline = import("sharp").Sharp;

let cached: SharpModule | undefined;

/**
 * Resolve `sharp`, caching the module after the first successful load.
 *
 * Cached because a modifier chain calls this once per operation and
 * `import()` of a native addon is not free — Node caches the module
 * record, but the await and the promise still cost something on a hot
 * upload path.
 *
 * The failure message names the install command. This is one of three
 * distinct "not installed" states an app can be in, and each gets its own
 * message:
 *
 *   1. No driver configured at all     → `NoImageDriverError` (from `media`)
 *   2. This driver configured, no sharp → here
 *   3. sharp present, op not supported  → `UnsupportedImageOpError` (from `media`)
 */
export async function loadSharp(): Promise<SharpModule> {
  if (cached !== undefined) {
    return cached;
  }

  try {
    // `sharp` is CommonJS, so an ESM `import()` of it yields a namespace
    // object whose `default` is the callable factory; the namespace
    // itself is not callable (verified against 0.35.5). `.default` is
    // therefore the only correct reference, exactly as
    // `storage-s3`'s loader takes the named exports off its namespace.
    cached = (await import("sharp")).default;

    return cached;
  } catch (error) {
    throw new Error(
      "The sharp image driver needs the `sharp` package, which is an optional peer " +
        "dependency of @mahiframework/media-sharp. Install it: `npm install sharp`.",
      { cause: error },
    );
  }
}

/**
 * Forget the cached module.
 *
 * Only for tests that assert the load path itself. Not exported from the
 * package index: an application has no reason to unload a native addon.
 */
export function resetSharpCache(): void {
  cached = undefined;
}
