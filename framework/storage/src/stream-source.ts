import { Readable } from "node:stream";
import type { StreamSource } from "./storage-driver.js";

/**
 * Normalize any accepted source into a Node `Readable`.
 *
 * Every driver's `putStream()` needs this, and so does anything handing a
 * `StreamSource` to a client library that is pickier than the contract:
 * `@aws-sdk/lib-storage`'s `Upload`, for one, rejects a bare
 * `AsyncIterable` outright, so normalizing is a correctness requirement
 * there rather than a convenience.
 */
export function toNodeReadable(source: StreamSource): Readable {
  if (source instanceof Readable) {
    return source;
  }

  if (typeof (source as ReadableStream<Uint8Array>).getReader === "function") {
    // `Readable.fromWeb` wants node:stream/web's ReadableStream; the global
    // (DOM) one is structurally identical at runtime.
    return Readable.fromWeb(source as Parameters<typeof Readable.fromWeb>[0]);
  }

  return Readable.from(source as AsyncIterable<Uint8Array>);
}
