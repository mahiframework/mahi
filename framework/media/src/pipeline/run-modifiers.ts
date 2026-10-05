import { Pipeline } from "@mahiframework/pipeline";
import { UndecodableImageError } from "../errors.js";
import type { ImageDriver } from "../image/image-driver.js";
import { extensionForMimeType, mimeTypeForExtension } from "../support/mime.js";
import { ModifierContext, type MediaModifier } from "./modifier.js";

/** What a modifier chain produced. */
export interface ModifiedImage {
  bytes: Uint8Array;
  /** The format it was encoded as, which may differ from the input's. */
  extension: string;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * Run an image through a chain of modifiers and encode the result.
 *
 * `Pipeline` from `@mahiframework/pipeline` builds the chain, so a
 * modifier can act before or after the rest of it. The terminal method
 * is `run()`, NEVER `then()` — that package's own source warns that a
 * `then()` would make a pipeline thenable, so `await`ing one would
 * execute it with `resolve` as its destination and an un-`send()`'d
 * pipeline would hang forever.
 *
 * The encode format defaults to the input's own, so a chain of pure
 * resizes keeps the file a PNG. A `format()` modifier in the chain
 * overrides it, which is why the options are decided here and read after
 * the chain rather than before.
 */
export async function runModifiers(
  driver: ImageDriver,
  driverName: string,
  bytes: Uint8Array,
  mimeType: string,
  modifiers: readonly MediaModifier[],
): Promise<ModifiedImage> {
  const inputExtension = extensionForMimeType(mimeType) ?? "png";

  let image;

  try {
    image = await driver.read(bytes);
  } catch (error) {
    // A file that passed the accept rules and sniffed as an image can
    // still fail to decode: a truncated upload, or a format the driver
    // was compiled without. Worth its own error, because the remedy is
    // different from "that type is not allowed".
    throw new UndecodableImageError(mimeType, { cause: error });
  }

  const context = new ModifierContext(driver, driverName, image, { format: inputExtension });

  const result = await new Pipeline<ModifierContext>()
    .send(context)
    .through(modifiers.map((entry) => entry.handle.bind(entry)))
    .run((final) => final);

  const encoded = await driver.encode(result.image, result.encode);
  const { width, height } = await driver.dimensions(result.image);

  return {
    bytes: encoded,
    extension: result.encode.format,
    mimeType: mimeTypeForFormat(result.encode.format, mimeType),
    width,
    height,
  };
}

/**
 * The MIME type for an encoded format.
 *
 * Falls back to the input's type when the format is one the table does
 * not name, which keeps a driver free to encode to something exotic
 * without this package having to know about it first.
 */
function mimeTypeForFormat(format: string, fallback: string): string {
  return mimeTypeForExtension(format) ?? fallback;
}
