import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

/**
 * Hash a buffer with `algorithm`.
 *
 * Any `node:crypto` digest name works, so an app can configure
 * `"sha512"` or `"blake2b512"` without this package enumerating them.
 */
export function checksum(contents: Uint8Array, algorithm: string): string {
  return createHash(algorithm).update(contents).digest("hex");
}

/**
 * Hash a stream without buffering it.
 *
 * What `verify()` uses: a checksum exists to detect a file changing
 * underneath us, and reading a 5GB video into memory to find that out
 * would make verification the most expensive thing the package does.
 */
export async function checksumStream(stream: Readable, algorithm: string): Promise<string> {
  const hash = createHash(algorithm);

  for await (const chunk of stream) {
    hash.update(chunk as Uint8Array);
  }

  return hash.digest("hex");
}

/**
 * Whether `algorithm` is one `node:crypto` can actually produce.
 *
 * Checked at provider boot rather than at first upload. `createHash()`
 * throws on an unknown name, and a typo in `config/media.ts` should fail
 * where it is fixable instead of on a user's first avatar.
 */
export function isSupportedAlgorithm(algorithm: string): boolean {
  try {
    createHash(algorithm);

    return true;
  } catch {
    return false;
  }
}
