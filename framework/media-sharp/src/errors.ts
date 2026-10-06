import { MediaError } from "@mahiframework/media";

/**
 * A modifier chain was run against an animated image.
 *
 * THE ALTERNATIVE IS SILENT DATA LOSS. This driver's handle holds one
 * frame of raw pixels (see `sharp-image-driver.ts` for why it must), so
 * an animated GIF or WebP that went through it would come out as a still
 * image of frame one. A user who uploaded an animation and got back a
 * photograph has lost something, would not be told, and would find out
 * months later from somebody else.
 *
 * Three options were available and this is the second:
 *
 *   1. Read frame one and document it. Most uses — avatar, thumbnail,
 *      hero — want a still anyway. But "most" is not "all", and the
 *      failure is invisible to the one case that did not.
 *   2. Refuse, and let the application decide. The animation survives
 *      because nothing touched it: the app catches this and stores the
 *      original unmodified, skips the modifiers for animated uploads, or
 *      rejects it outright. All three are better than a lie.
 *   3. Full animated support — `{ animated: true }`, per-frame ops and a
 *      frame-aware handle. A much larger piece of work, and out of scope
 *      for a first version.
 *
 * ## Catching it
 *
 * Raised from `read()`, which `media`'s `runModifiers()` wraps: what an
 * upload actually throws is `UndecodableImageError`, with this as its
 * `cause`. That wrapping is deliberate on `media`'s side — every decode
 * failure gets one error type — so the check is on the cause:
 *
 * ```ts
 * try {
 *   await user.avatar().withModifiers([resizeDown(512)]).add(file);
 * } catch (error) {
 *   if (error instanceof UndecodableImageError && error.cause instanceof AnimatedImageError) {
 *     // Store it untouched: the animation is still intact.
 *     await user.avatar().add(file);
 *   }
 * }
 * ```
 *
 * To avoid the round trip entirely, branch before adding —
 * `isAnimated(bytes)` from this package answers the same question
 * without decoding a frame.
 *
 * Extends `MediaError` so an app catching the family around an upload
 * catches this too, rather than having to know this package exists.
 */
export class AnimatedImageError extends MediaError {
  constructor(
    /** How many frames the image turned out to have. */
    readonly pages: number,
  ) {
    super(
      `This image has ${pages} frames, and the sharp image driver transforms one frame at a ` +
        `time — so running modifiers over it would flatten the animation to a still. Store it ` +
        `without modifiers to keep the animation, check isAnimated() before adding, or set ` +
        `allowAnimated: true in config/media.ts under "media.sharp" to accept the flattening.`,
    );
  }
}
