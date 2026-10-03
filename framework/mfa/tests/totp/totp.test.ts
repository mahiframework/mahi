import { describe, expect, it } from "vitest";
import { encodeBase32 } from "../../src/totp/base32.js";
import {
  generateCode,
  generateCodeForStep,
  generateSecret,
  timestepAt,
  verifyCode,
  type TotpAlgorithm,
} from "../../src/totp/totp.js";

/**
 * RFC 6238 Appendix B test vectors.
 *
 * The seeds are given in the RFC as ASCII strings ("12345678901234567890"
 * repeated to the hash's block size), so they are base32-encoded here
 * rather than hard-coded, which also exercises the encoder against known
 * input. The 8-digit codes are what the RFC tabulates; the 6-digit
 * variants are the same values truncated, which is how the algorithm is
 * defined, so they are derived rather than listed.
 */
const SEED_SHA1 = encodeBase32(Buffer.from("12345678901234567890", "utf-8"));
const SEED_SHA256 = encodeBase32(Buffer.from("12345678901234567890123456789012", "utf-8"));
const SEED_SHA512 = encodeBase32(
  Buffer.from("1234567890123456789012345678901234567890123456789012345678901234", "utf-8"),
);

interface Vector {
  time: number;
  sha1: string;
  sha256: string;
  sha512: string;
}

/** Appendix B, verbatim. 8 digits, 30-second period. */
const VECTORS: Vector[] = [
  { time: 59, sha1: "94287082", sha256: "46119246", sha512: "90693936" },
  { time: 1111111109, sha1: "07081804", sha256: "68084774", sha512: "25091201" },
  { time: 1111111111, sha1: "14050471", sha256: "67062674", sha512: "99943326" },
  { time: 1234567890, sha1: "89005924", sha256: "91819424", sha512: "93441116" },
  { time: 2000000000, sha1: "69279037", sha256: "90698825", sha512: "38618901" },
  { time: 20000000000, sha1: "65353130", sha256: "77737706", sha512: "47863826" },
];

const SEEDS: Record<TotpAlgorithm, string> = {
  SHA1: SEED_SHA1,
  SHA256: SEED_SHA256,
  SHA512: SEED_SHA512,
};

describe("RFC 6238 Appendix B vectors", () => {
  for (const vector of VECTORS) {
    for (const algorithm of ["SHA1", "SHA256", "SHA512"] as TotpAlgorithm[]) {
      const expected = vector[algorithm.toLowerCase() as "sha1" | "sha256" | "sha512"];

      it(`${algorithm} at t=${vector.time} is ${expected}`, () => {
        expect(generateCode(SEEDS[algorithm], { at: vector.time, digits: 8, algorithm })).toBe(
          expected,
        );
      });
    }
  }

  it("6-digit codes are the 8-digit ones truncated", () => {
    // Not a separate vector table: RFC 4226 §5.3 defines the code as the
    // low `digits` decimal places of one binary value, so a 6-digit code
    // is arithmetically the last six characters of the 8-digit one.
    for (const vector of VECTORS) {
      expect(generateCode(SEED_SHA1, { at: vector.time, digits: 6 })).toBe(vector.sha1.slice(-6));
    }
  });

  it("the counter survives past a 32-bit time step", () => {
    // t=20000000000 is step 666666666, which is under 2^31, so the last
    // RFC vector does not actually exercise the 64-bit write. This does:
    // a step past 2^32 would silently wrap a bitwise implementation.
    const step = 2 ** 33;
    expect(generateCodeForStep(SEED_SHA1, step, { digits: 8 })).toMatch(/^\d{8}$/);
    expect(generateCodeForStep(SEED_SHA1, step, { digits: 8 })).not.toBe(
      generateCodeForStep(SEED_SHA1, step + 1, { digits: 8 }),
    );
  });
});

describe("timestepAt", () => {
  it("floors to the period", () => {
    expect(timestepAt(0)).toBe(0);
    expect(timestepAt(29)).toBe(0);
    expect(timestepAt(30)).toBe(1);
    expect(timestepAt(59)).toBe(1);
    expect(timestepAt(1111111109)).toBe(37037036);
  });

  it("honours a non-default period", () => {
    expect(timestepAt(60, 60)).toBe(1);
    expect(timestepAt(59, 60)).toBe(0);
  });
});

describe("generateSecret", () => {
  it("produces a decodable base32 secret of the requested size", () => {
    // 20 bytes = 160 bits = 32 base32 characters.
    expect(generateSecret()).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateSecret(32)).toMatch(/^[A-Z2-7]{52}$/);
  });

  it("does not repeat", () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateSecret()));
    expect(secrets.size).toBe(50);
  });

  it("produces a secret that generates verifiable codes", () => {
    const secret = generateSecret();
    expect(verifyCode(secret, generateCode(secret)).valid).toBe(true);
  });
});

describe("verifyCode", () => {
  const at = 1111111111;
  const code = generateCode(SEED_SHA1, { at });

  it("accepts the current step and reports which step matched", () => {
    expect(verifyCode(SEED_SHA1, code, { at })).toEqual({
      valid: true,
      step: timestepAt(at),
    });
  });

  it("accepts a code from exactly ±window steps away", () => {
    const current = timestepAt(at);

    for (const offset of [-1, 1]) {
      const skewed = generateCodeForStep(SEED_SHA1, current + offset);
      expect(verifyCode(SEED_SHA1, skewed, { at, window: 1 })).toEqual({
        valid: true,
        step: current + offset,
      });
    }
  });

  it("rejects a code from ±(window + 1) steps away", () => {
    const current = timestepAt(at);

    for (const offset of [-2, 2]) {
      const skewed = generateCodeForStep(SEED_SHA1, current + offset);
      expect(verifyCode(SEED_SHA1, skewed, { at, window: 1 })).toEqual({
        valid: false,
        step: null,
      });
    }
  });

  it("window 0 accepts only the current step", () => {
    const current = timestepAt(at);
    expect(verifyCode(SEED_SHA1, code, { at, window: 0 }).valid).toBe(true);
    expect(
      verifyCode(SEED_SHA1, generateCodeForStep(SEED_SHA1, current - 1), { at, window: 0 }).valid,
    ).toBe(false);
  });

  it("rejects a wrong code", () => {
    expect(verifyCode(SEED_SHA1, "000000", { at })).toEqual({ valid: false, step: null });
  });

  it("rejects a code of the wrong length without throwing", () => {
    // `timingSafeEqual` throws on a length mismatch, so this has to be
    // guarded before the comparison rather than relying on it.
    for (const wrong of ["", "1", "12345", "1234567", "1".repeat(64)]) {
      expect(verifyCode(SEED_SHA1, wrong, { at })).toEqual({ valid: false, step: null });
    }
  });

  it("tolerates whitespace in a pasted code", () => {
    expect(verifyCode(SEED_SHA1, ` ${code.slice(0, 3)} ${code.slice(3)} `, { at }).valid).toBe(
      true,
    );
  });

  describe("replay defense", () => {
    it("rejects the step that `after` names, even with the right code", () => {
      const current = timestepAt(at);

      expect(verifyCode(SEED_SHA1, code, { at, after: current })).toEqual({
        valid: false,
        step: null,
      });
    });

    it("rejects every step at or below `after`", () => {
      const current = timestepAt(at);
      const previous = generateCodeForStep(SEED_SHA1, current - 1);

      expect(verifyCode(SEED_SHA1, previous, { at, window: 1, after: current })).toEqual({
        valid: false,
        step: null,
      });
    });

    it("still accepts a step above `after`", () => {
      const current = timestepAt(at);

      expect(verifyCode(SEED_SHA1, code, { at, after: current - 1 })).toEqual({
        valid: true,
        step: current,
      });
    });

    it("a code accepted once is rejected on replay within the same period", () => {
      // The whole point of returning `step`: the caller persists it and
      // feeds it back as `after`. Without that this same code verifies
      // for the full window, up to three periods at window 1.
      const first = verifyCode(SEED_SHA1, code, { at });
      expect(first.valid).toBe(true);

      const replay = verifyCode(SEED_SHA1, code, { at, after: first.step });
      expect(replay.valid).toBe(false);
    });
  });

  it("verifies against a non-default digit count", () => {
    const eight = generateCode(SEED_SHA1, { at, digits: 8 });
    expect(verifyCode(SEED_SHA1, eight, { at, digits: 8 }).valid).toBe(true);
    // The 6-digit reading of an 8-digit code must not pass as 6 digits.
    expect(verifyCode(SEED_SHA1, eight, { at, digits: 6 }).valid).toBe(false);
  });

  it("verifies against a non-default algorithm", () => {
    const sha256 = generateCode(SEED_SHA256, { at, algorithm: "SHA256" });
    expect(verifyCode(SEED_SHA256, sha256, { at, algorithm: "SHA256" }).valid).toBe(true);
    // Wrong algorithm must not verify, or the `algorithm` config would be
    // decorative.
    expect(verifyCode(SEED_SHA256, sha256, { at, algorithm: "SHA1" }).valid).toBe(false);
  });

  it("does not crash near the epoch, where the window reaches below step 0", () => {
    expect(verifyCode(SEED_SHA1, "000000", { at: 0, window: 2 }).valid).toBe(false);
    const code0 = generateCodeForStep(SEED_SHA1, 0);
    expect(verifyCode(SEED_SHA1, code0, { at: 0, window: 2 })).toEqual({
      valid: true,
      step: 0,
    });
  });
});
