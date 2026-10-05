import type { Next } from "@mahiframework/pipeline";
import { UnsupportedImageOpError } from "../errors.js";
import type {
  EncodeOptions,
  ImageDriver,
  ImageHandle,
  ImageOp,
  ImageOpType,
} from "../image/image-driver.js";

/**
 * The value a modifier chain passes along.
 *
 * Carries the decoded image AND the encode options separately, which is
 * the distinction that makes `format()` and `quality()` possible: they
 * change how the result is written without touching a pixel, and their
 * effect lands at encode time rather than when they run.
 *
 * Mutable, and modifiers are expected to mutate it. A pipeline whose
 * every stage rebuilt the context would make `place()` — which holds a
 * second image handle — awkward for no benefit, since the context lives
 * only for the length of one upload.
 */
export class ModifierContext {
  constructor(
    readonly driver: ImageDriver,
    readonly driverName: string,
    public image: ImageHandle,
    public encode: EncodeOptions,
  ) {}

  /**
   * Run one operation through the driver.
   *
   * The only path a modifier should use. It checks `supports()` first,
   * so an unsupported operation fails naming both the driver and the
   * operation rather than throwing from inside the driver — and fails at
   * all, rather than silently doing nothing.
   */
  async apply(op: ImageOp): Promise<void> {
    if (!this.driver.supports(op.type as ImageOpType)) {
      throw new UnsupportedImageOpError(this.driverName, op.type);
    }

    this.image = await this.driver.apply(this.image, op);
  }

  /** Current dimensions, for a modifier that needs to measure first. */
  dimensions(): Promise<{ width: number; height: number }> {
    return this.driver.dimensions(this.image);
  }
}

/**
 * One step in the transformation of an uploaded image.
 *
 * Middleware-shaped, so a modifier can act before `next`, after it, or
 * both. laravel-media's optimizers use the "after" position — they run
 * the rest of the chain first and then compress the result — and that
 * ordering is worth keeping available even though the optimizers
 * themselves are a driver concern here.
 *
 * `name` is for error messages and for the `FakeImageDriver`'s
 * assertions. It is not an identity: two `resizeDown` modifiers in one
 * chain are both named `resizeDown`, which is fine.
 */
export interface MediaModifier {
  readonly name: string;

  /**
   * The format this modifier forces the output into, if it forces one.
   *
   * Declared as DATA rather than discovered by running the modifier,
   * because the upload path has to know the final extension BEFORE it
   * generates a storage path — otherwise a `format("webp")` chain writes
   * a `.png` path containing WebP bytes, which is exactly the
   * inconsistency laravel-media ships (its `updateOriginal()` writes new
   * bytes to the old path and only the columns change).
   *
   * Only `format()` sets this.
   */
  readonly targetFormat?: string;

  handle(
    context: ModifierContext,
    next: Next<ModifierContext, ModifierContext>,
  ): Promise<ModifierContext>;
}

/**
 * Build a modifier from a name and a function.
 *
 * Every shipped modifier is written this way. A class per modifier would
 * carry no state worth the ceremony — the parameters are closed over.
 */
export function modifier(
  name: string,
  handle: (
    context: ModifierContext,
    next: Next<ModifierContext, ModifierContext>,
  ) => Promise<ModifierContext>,
  extra?: { targetFormat?: string },
): MediaModifier {
  return { name, handle, targetFormat: extra?.targetFormat };
}

/**
 * A modifier that transforms the image and then continues.
 *
 * The common shape: do the work, call `next`. Written once here so each
 * modifier is just its operation.
 */
export function imageModifier(
  name: string,
  transform: (context: ModifierContext) => Promise<void>,
): MediaModifier {
  return modifier(name, async (context, next) => {
    await transform(context);

    return next(context);
  });
}
