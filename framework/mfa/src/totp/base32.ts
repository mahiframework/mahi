/**
 * RFC 4648 base32, the encoding every authenticator app expects a TOTP
 * secret in.
 *
 * Hand-rolled rather than taken as a dependency for the same reason the
 * rest of this package is: it is forty lines of bit-shuffling with a
 * fixed, standardised alphabet, and `node:buffer` has no base32. The
 * alternative is an npm package in the trust path of every MFA
 * enrollment.
 *
 * PADDING IS OMITTED on encode. RFC 4648 §6 allows `=` padding to a
 * 40-bit boundary, but the `otpauth://` URI format does not want it
 * (padding would have to be percent-encoded in the query string, and
 * several authenticator apps reject the result), so `encodeBase32`
 * never emits it. `decodeBase32` accepts it anyway, since a secret
 * pasted from elsewhere may carry it.
 */

/** RFC 4648 §6, "Base 32 Encoding". Upper-case, no `0`/`1`/`8`. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export class Base32Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Base32Error";
  }
}

/**
 * Encode bytes as unpadded base32.
 *
 * Accumulates bits in a buffer and emits a character every time five are
 * available, which is simpler to verify than a table-driven 5-byte-block
 * implementation and measurably fast enough for secrets of 20-32 bytes.
 */
export function encodeBase32(bytes: Uint8Array): string {
  let output = "";
  let bits = 0;
  let value = 0;

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      // Shift the top five bits down, then mask: `& 31` is what keeps
      // this correct once `value` has accumulated more than five bits.
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  // Trailing bits, left-aligned into a final character. Dropping them
  // would silently truncate any secret whose length is not a multiple of
  // five bytes, which includes the 20-byte RFC 6238 test secret.
  if (bits > 0) {
    output += ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Decode base32 back to bytes.
 *
 * Case-insensitive, and tolerant of the two things humans do to a secret
 * they have been shown: spaces every four characters, and `=` padding.
 * Anything else outside the alphabet throws rather than being skipped,
 * because silently ignoring a stray character would turn a mistyped
 * secret into a different valid secret, and the resulting codes would
 * simply never match with no indication why.
 */
export function decodeBase32(encoded: string): Uint8Array {
  const cleaned = encoded.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();

  if (cleaned === "") {
    return new Uint8Array(0);
  }

  const bytes: number[] = [];
  let bits = 0;
  let value = 0;

  for (const char of cleaned) {
    const index = ALPHABET.indexOf(char);

    if (index === -1) {
      throw new Base32Error(`"${char}" is not a valid base32 character.`);
    }

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  // Leftover bits are the encoder's left-aligned padding and are
  // discarded. They cannot form a whole byte by definition, so there is
  // nothing to recover and no error to report.
  return new Uint8Array(bytes);
}
