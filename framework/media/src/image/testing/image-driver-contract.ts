import { IMAGE_OPS, type ImageDriver, type ImageOpType } from "../image-driver.js";

/**
 * The `ImageDriver` contract, as executable cases.
 *
 * Six methods carrying guarantees the signatures do not show:
 * `scaleDown` preserves aspect ratio and never enlarges, `apply`
 * returns a usable handle whether the driver is immutable or in-place,
 * `supports()` agrees with what `apply()` actually does, `read()` throws
 * on garbage rather than returning a broken handle. A driver can satisfy
 * the types and miss every one of those, which is how two
 * implementations behind one interface drift into two different
 * abstractions.
 *
 * Runner-agnostic on purpose: cases are plain objects with a `run()`,
 * and failures are thrown `Error`s rather than matcher calls, so this
 * package keeps its no-test-runner dependency — the same reasoning as
 * `FakeImageDriver`'s assertions and
 * `@mahiframework/storage`'s `storageDriverContract()`. A vitest file is
 * three lines:
 *
 * ```ts
 * for (const testCase of imageDriverContract(() => new SharpImageDriver())) {
 *   it(testCase.name, () => testCase.run());
 * }
 * ```
 */
export interface ImageDriverContractCase {
  name: string;
  run(): Promise<void>;
}

export interface ImageDriverContractOptions {
  /**
   * A decodable image of known size, as bytes.
   *
   * Required: a driver that really decodes needs real input, and the
   * contract cannot invent a valid PNG for every possible driver.
   */
  image: () => Promise<Uint8Array> | Uint8Array;

  /** The dimensions `image` decodes to, so geometry can be checked. */
  width: number;
  height: number;

  /**
   * Operations this driver is not expected to implement.
   *
   * The contract then asserts the HONEST failure instead of the
   * behaviour: `supports()` returns false and `apply()` throws. A driver
   * that quietly ignores an op it cannot do is the failure mode this
   * exists to prevent.
   */
  unsupported?: ImageOpType[];

  /** Formats `encode()` must handle. Defaults to `["png", "jpg", "webp"]`. */
  formats?: string[];
}

export function imageDriverContract(
  driver: () => ImageDriver,
  options: ImageDriverContractOptions,
): ImageDriverContractCase[] {
  const unsupported = new Set(options.unsupported ?? []);
  const formats = options.formats ?? ["png", "jpg", "webp"];
  const bytes = async (): Promise<Uint8Array> => options.image();

  const cases: ImageDriverContractCase[] = [
    {
      name: "reads an image and reports its dimensions",
      async run() {
        const image = await driver().read(await bytes());
        const size = await driver().dimensions(image);

        expect(size.width, options.width, "decoded width");
        expect(size.height, options.height, "decoded height");
      },
    },

    {
      name: "rejects bytes that are not an image",
      async run() {
        // Must throw rather than return a handle that fails later: the
        // upload path turns this into `UndecodableImageError`, and a
        // driver that defers the failure loses that.
        await expectThrows(
          () => driver().read(new TextEncoder().encode("definitely not an image")),
          "read() of non-image bytes",
        );
      },
    },

    {
      name: "creates a blank canvas at the requested size",
      async run() {
        const image = await driver().create(120, 80);
        const size = await driver().dimensions(image);

        expect(size.width, 120, "created width");
        expect(size.height, 80, "created height");
      },
    },

    {
      name: "agrees with itself about what it supports",
      async run() {
        const subject = driver();

        for (const op of IMAGE_OPS) {
          const claimed = subject.supports(op);
          const expected = !unsupported.has(op);

          if (claimed !== expected) {
            throw new Error(
              `supports("${op}") returned ${claimed}, but the contract was told ` +
                `${expected}. A driver must report its capabilities honestly.`,
            );
          }
        }
      },
    },

    {
      name: "encodes to every format it claims",
      async run() {
        for (const format of formats) {
          const subject = driver();
          const image = await subject.read(await bytes());
          const encoded = await subject.encode(image, { format });

          if (encoded.byteLength === 0) {
            throw new Error(`encode() produced no bytes for format "${format}".`);
          }
        }
      },
    },

    {
      name: "returns a handle from apply() that is still usable",
      async run() {
        // The immutable-versus-in-place question. Either is fine; what
        // matters is that the RETURN VALUE works, so callers can always
        // use it and never have to know which kind they have.
        const subject = driver();
        const image = await subject.read(await bytes());
        const applied = await subject.apply(image, { type: "scaleDown", width: 50 });
        const size = await subject.dimensions(applied);

        if (size.width > 50) {
          throw new Error(
            `The handle returned by apply() reports width ${size.width}, so the ` +
              `operation did not take effect on it.`,
          );
        }
      },
    },
  ];

  if (!unsupported.has("scaleDown")) {
    cases.push(
      {
        name: "scaleDown preserves aspect ratio",
        async run() {
          const subject = driver();
          const image = await subject.read(await bytes());
          const target = Math.floor(options.width / 2);
          const applied = await subject.apply(image, { type: "scaleDown", width: target });
          const size = await subject.dimensions(applied);

          const expectedHeight = Math.round(options.height * (target / options.width));

          // One pixel of slack: rounding differs between libraries and
          // is not worth forcing into agreement.
          if (Math.abs(size.height - expectedHeight) > 1) {
            throw new Error(
              `scaleDown to width ${target} gave height ${size.height}, expected about ` +
                `${expectedHeight}. Aspect ratio was not preserved.`,
            );
          }
        },
      },

      {
        name: "scaleDown never enlarges",
        async run() {
          // The property that separates it from a plain resize.
          // Upscaling invents detail and makes every small logo worse.
          const subject = driver();
          const image = await subject.read(await bytes());
          const applied = await subject.apply(image, {
            type: "scaleDown",
            width: options.width * 4,
            height: options.height * 4,
          });
          const size = await subject.dimensions(applied);

          if (size.width > options.width || size.height > options.height) {
            throw new Error(
              `scaleDown enlarged the image to ${size.width}x${size.height} from ` +
                `${options.width}x${options.height}. It must only shrink.`,
            );
          }
        },
      },

      {
        name: "scaleDown bounds by one dimension when only one is given",
        async run() {
          const subject = driver();
          const image = await subject.read(await bytes());
          const applied = await subject.apply(image, { type: "scaleDown", height: 40 });
          const size = await subject.dimensions(applied);

          expect(size.height, 40, "height when bounded by height alone");
        },
      },
    );
  }

  if (!unsupported.has("crop")) {
    cases.push({
      name: "crop produces exactly the requested rectangle",
      async run() {
        const subject = driver();
        const image = await subject.read(await bytes());
        const applied = await subject.apply(image, {
          type: "crop",
          width: 20,
          height: 10,
          x: 1,
          y: 2,
        });
        const size = await subject.dimensions(applied);

        expect(size.width, 20, "cropped width");
        expect(size.height, 10, "cropped height");
      },
    });
  }

  if (!unsupported.has("rotate")) {
    cases.push({
      name: "rotating by 90 degrees swaps the dimensions",
      async run() {
        const subject = driver();
        const image = await subject.read(await bytes());
        const applied = await subject.apply(image, { type: "rotate", degrees: 90 });
        const size = await subject.dimensions(applied);

        expect(size.width, options.height, "width after a quarter turn");
        expect(size.height, options.width, "height after a quarter turn");
      },
    });
  }

  if (!unsupported.has("fill") && !unsupported.has("place")) {
    cases.push({
      name: "fill then place leaves the dimensions alone",
      async run() {
        // The `setBackgroundColor` path: fill a canvas, composite the
        // original over it. Compositing must not resize anything.
        const subject = driver();
        const image = await subject.read(await bytes());
        const canvas = await subject.create(options.width, options.height);
        const filled = await subject.apply(canvas, { type: "fill", color: "#ffffff" });
        const placed = await subject.apply(filled, { type: "place", image, x: 0, y: 0 });
        const size = await subject.dimensions(placed);

        expect(size.width, options.width, "width after compositing");
        expect(size.height, options.height, "height after compositing");
      },
    });
  }

  for (const op of unsupported) {
    cases.push({
      name: `throws rather than ignoring the unsupported "${op}" op`,
      async run() {
        const subject = driver();
        const image = await subject.read(await bytes());

        await expectThrows(
          () => subject.apply(image, stubOp(op)),
          `apply() of the unsupported "${op}" op`,
        );
      },
    });
  }

  return cases;
}

/** A minimal valid instance of each op, for the unsupported-path cases. */
function stubOp(op: ImageOpType): Parameters<ImageDriver["apply"]>[1] {
  switch (op) {
    case "scaleDown":
      return { type: "scaleDown", width: 10 };
    case "crop":
      return { type: "crop", width: 10, height: 10, x: 0, y: 0 };
    case "fill":
      return { type: "fill", color: "#000000" };
    case "place":
      return { type: "place", image: { __image: null }, x: 0, y: 0 };
    case "rotate":
      return { type: "rotate", degrees: 90 };
  }
}

function expect(actual: number, wanted: number, label: string): void {
  if (actual !== wanted) {
    throw new Error(`Expected ${label} to be ${wanted}, got ${actual}.`);
  }
}

async function expectThrows(run: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await run();
  } catch {
    return;
  }

  throw new Error(`Expected ${label} to throw, but it resolved.`);
}
