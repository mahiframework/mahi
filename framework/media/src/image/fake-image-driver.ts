import { isRasterImage } from "../support/mime.js";
import { sniffMimeType } from "../support/sniff.js";
import type {
  EncodeOptions,
  ImageDriver,
  ImageHandle,
  ImageOp,
  ImageOpType,
} from "./image-driver.js";
import { IMAGE_OPS } from "./image-driver.js";

/** A fake image: dimensions, a colour, and the ops applied to it. */
interface FakeImage extends ImageHandle {
  readonly __image: {
    width: number;
    height: number;
    color: string | null;
    /** Every op this handle has been through, newest last. */
    ops: ImageOp[];
  };
}

/**
 * An `ImageDriver` that decodes nothing and records everything.
 *
 * The point is that modifier behaviour is testable without an image
 * library. A `resizeDown(200, 200)` is correct if it emits
 * `{ type: "scaleDown", width: 200, height: 200 }` and the resulting
 * dimensions are right; whether libvips produces good pixels is
 * libvips's business, and asserting on real encoded bytes would make
 * these tests a test of sharp.
 *
 * Mirrors `@mahiframework/storage`'s `FakeStorageDriver`: assertions
 * live on the fake and throw plain `Error`s rather than calling matchers,
 * so this package keeps its no-test-runner-dependency property and the
 * fake is usable from an application's own suite.
 *
 * Geometry is tracked faithfully — `scaleDown` really does preserve
 * aspect ratio and really does refuse to enlarge — because that is the
 * logic the modifiers own and therefore the logic worth testing.
 */
export class FakeImageDriver implements ImageDriver {
  /** Every op applied through this driver, across all handles. */
  readonly applied: ImageOp[] = [];

  /** Every encode call, in order. */
  readonly encoded: EncodeOptions[] = [];

  private unsupported = new Set<ImageOpType>();

  /**
   * @param width  the dimensions `read()` reports, since the fake does
   *               not parse real headers.
   * @param height
   */
  constructor(
    private readonly width = 1000,
    private readonly height = 800,
  ) {}

  /**
   * Make this driver report an op as unsupported.
   *
   * For testing the degradation path: a driver that cannot crop must
   * produce a clear error naming itself and the op, not silently skip.
   */
  without(...ops: ImageOpType[]): this {
    for (const op of ops) {
      this.unsupported.add(op);
    }

    return this;
  }

  /**
   * "Decode" bytes.
   *
   * No pixels are parsed, but the input IS checked: anything that does
   * not sniff as a raster image throws, because a real decoder does and
   * the upload path turns that into `UndecodableImageError`. A fake that
   * accepted everything would let a caller's missing error handling pass
   * its tests — and `imageDriverContract()` asserts this exact
   * behaviour, so the fake has to honour the same rule it holds real
   * drivers to.
   */
  async read(bytes: Uint8Array): Promise<ImageHandle> {
    const sniffed = sniffMimeType(bytes);

    if (sniffed === undefined || !isRasterImage(sniffed)) {
      throw new Error(
        `The fake image driver cannot read these bytes as an image (sniffed: ${
          sniffed ?? "unrecognised"
        }).`,
      );
    }

    return this.handle(this.width, this.height, null);
  }

  async create(width: number, height: number): Promise<ImageHandle> {
    return this.handle(width, height, null);
  }

  async apply(image: ImageHandle, op: ImageOp): Promise<ImageHandle> {
    if (!this.supports(op.type)) {
      throw new Error(`The fake image driver has "${op.type}" disabled.`);
    }

    const state = this.state(image);

    this.applied.push(op);
    state.ops.push(op);

    switch (op.type) {
      case "scaleDown": {
        const { width, height } = scaleDown(state.width, state.height, op.width, op.height);

        state.width = width;
        state.height = height;
        break;
      }

      case "crop": {
        state.width = op.width;
        state.height = op.height;
        break;
      }

      case "fill": {
        state.color = op.color;
        break;
      }

      case "place": {
        // Compositing changes no dimensions; the placed image's own ops
        // are folded in so an assertion can see the whole history.
        state.ops.push(...this.state(op.image).ops);
        break;
      }

      case "rotate": {
        if (op.degrees % 180 !== 0) {
          const { width, height } = state;

          state.width = height;
          state.height = width;
        }

        break;
      }
    }

    return image;
  }

  async encode(image: ImageHandle, options: EncodeOptions): Promise<Uint8Array> {
    this.encoded.push(options);

    const state = this.state(image);

    // Bytes that describe themselves, so a test reading the stored file
    // can assert what was encoded without an image parser.
    return new TextEncoder().encode(
      JSON.stringify({
        format: options.format,
        quality: options.quality ?? null,
        width: state.width,
        height: state.height,
        color: state.color,
        ops: state.ops.map((op) => op.type),
      }),
    );
  }

  async dimensions(image: ImageHandle): Promise<{ width: number; height: number }> {
    const { width, height } = this.state(image);

    return { width, height };
  }

  supports(op: ImageOpType): boolean {
    return IMAGE_OPS.includes(op) && !this.unsupported.has(op);
  }

  // ------------------------------------------------------------ assertions

  /** Assert an op of this type was applied. Throws on failure. */
  assertApplied(type: ImageOpType): void {
    if (!this.applied.some((op) => op.type === type)) {
      throw new Error(
        `Failed asserting that a "${type}" op was applied. Applied: ` +
          `${JSON.stringify(this.applied.map((op) => op.type))}.`,
      );
    }
  }

  /** Assert no op of this type was applied. */
  assertNotApplied(type: ImageOpType): void {
    if (this.applied.some((op) => op.type === type)) {
      throw new Error(`Failed asserting that no "${type}" op was applied.`);
    }
  }

  /** Assert the exact sequence of op types, which is what ordering bugs show up in. */
  assertSequence(types: readonly ImageOpType[]): void {
    const actual = this.applied.map((op) => op.type);

    if (actual.length !== types.length || actual.some((type, index) => type !== types[index])) {
      throw new Error(
        `Failed asserting the op sequence. Expected ${JSON.stringify(types)}, ` +
          `got ${JSON.stringify(actual)}.`,
      );
    }
  }

  /** Every op of one type, for asserting on arguments. */
  opsOfType<T extends ImageOpType>(type: T): Extract<ImageOp, { type: T }>[] {
    return this.applied.filter((op): op is Extract<ImageOp, { type: T }> => op.type === type);
  }

  /** Forget everything recorded, for a test reusing one driver. */
  reset(): void {
    this.applied.length = 0;
    this.encoded.length = 0;
    this.unsupported = new Set();
  }

  private handle(width: number, height: number, color: string | null): FakeImage {
    return { __image: { width, height, color, ops: [] } };
  }

  private state(image: ImageHandle): FakeImage["__image"] {
    const state = image.__image;

    if (!isFakeState(state)) {
      throw new Error(
        "The fake image driver was handed a handle it did not create. Image handles are " +
          "opaque and driver-specific; they cannot be passed between drivers.",
      );
    }

    return state;
  }
}

function isFakeState(value: unknown): value is FakeImage["__image"] {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FakeImage["__image"]).width === "number" &&
    Array.isArray((value as FakeImage["__image"]).ops)
  );
}

/**
 * Fit inside the given bounds without enlarging, preserving ratio.
 *
 * Real geometry rather than a stub, because this is the arithmetic
 * `resizeDown` depends on and a fake that got it wrong would make every
 * dimension assertion meaningless.
 */
export function scaleDown(
  width: number,
  height: number,
  maxWidth: number | undefined,
  maxHeight: number | undefined,
): { width: number; height: number } {
  const widthRatio = maxWidth === undefined ? 1 : maxWidth / width;
  const heightRatio = maxHeight === undefined ? 1 : maxHeight / height;
  // `1` in the min is what makes it scale DOWN only.
  const ratio = Math.min(1, widthRatio, heightRatio);

  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}
