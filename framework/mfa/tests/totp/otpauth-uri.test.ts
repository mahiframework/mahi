import { describe, expect, it } from "vitest";
import { otpauthUri } from "../../src/totp/otpauth-uri.js";

describe("otpauthUri", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("builds the Google Key URI shape", () => {
    const uri = otpauthUri({ secret, account: "alice@example.com", issuer: "Acme" });

    expect(uri).toBe("otpauth://totp/Acme:alice%40example.com?secret=" + secret + "&issuer=Acme");
  });

  it("omits the issuer prefix when there is no issuer", () => {
    expect(otpauthUri({ secret, account: "alice@example.com" })).toBe(
      "otpauth://totp/alice%40example.com?secret=" + secret,
    );
  });

  it("omits parameters that match the universal defaults", () => {
    // Emitting `algorithm=SHA1` breaks several authenticator apps, and
    // the shortest URI describing the default config is the most
    // interoperable one.
    const uri = otpauthUri({
      secret,
      account: "a@b.test",
      digits: 6,
      period: 30,
      algorithm: "SHA1",
    });

    expect(uri).not.toContain("algorithm");
    expect(uri).not.toContain("digits");
    expect(uri).not.toContain("period");
  });

  it("emits parameters that differ from the defaults", () => {
    const uri = otpauthUri({
      secret,
      account: "a@b.test",
      digits: 8,
      period: 60,
      algorithm: "SHA256",
    });

    const parsed = new URL(uri);
    expect(parsed.searchParams.get("algorithm")).toBe("SHA256");
    expect(parsed.searchParams.get("digits")).toBe("8");
    expect(parsed.searchParams.get("period")).toBe("60");
  });

  it("escapes a colon in either label half", () => {
    // An unescaped colon would break the `issuer:account` split and the
    // app would show a mangled credential name.
    const uri = otpauthUri({ secret, account: "we:ird", issuer: "Ac:me" });

    expect(uri).toContain("Ac%3Ame:we%3Aird");
  });

  it("produces a parseable URL whose secret round-trips", () => {
    const parsed = new URL(otpauthUri({ secret, account: "a@b.test", issuer: "Acme" }));

    expect(parsed.protocol).toBe("otpauth:");
    expect(parsed.host).toBe("totp");
    expect(parsed.searchParams.get("secret")).toBe(secret);
    expect(parsed.searchParams.get("issuer")).toBe("Acme");
  });
});
