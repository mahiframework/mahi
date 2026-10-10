import { describe, expect, it } from "vitest";
import {
  UnsafeUrlError,
  assertSafeUrl,
  isAllowedAddress,
  isMetadataAddress,
  isPrivateAddress,
  resolveSafeAddresses,
} from "../src/url-safety.js";

/**
 * No hostname that needs the internet appears below. Every case either
 * uses an IP literal (which `assertSafeUrl()` short-circuits without a
 * resolver), `localhost` (resolved from the hosts file), or
 * `allowHosts`. A URL-safety suite that fails when the network is down
 * is a suite nobody trusts.
 */

/** The `UnsafeUrlError` a promise rejected with, or a failure. */
async function rejection(promise: Promise<unknown>): Promise<UnsafeUrlError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      return error;
    }

    throw error;
  }

  throw new Error("Expected the URL to be rejected, but it was accepted.");
}

describe("schemes", () => {
  it("rejects file:", async () => {
    const error = await rejection(assertSafeUrl("file:///etc/passwd"));

    expect(error.rule).toBe("scheme");
  });

  it("rejects data:", async () => {
    expect((await rejection(assertSafeUrl("data:text/plain,hi"))).rule).toBe("scheme");
  });

  it("rejects gopher: and ftp:", async () => {
    expect((await rejection(assertSafeUrl("gopher://198.51.100.7/"))).rule).toBe("scheme");
    expect((await rejection(assertSafeUrl("ftp://198.51.100.7/"))).rule).toBe("scheme");
  });

  it("accepts http and https by default", async () => {
    await expect(assertSafeUrl("https://93.184.216.34/")).resolves.toBeInstanceOf(URL);
    await expect(assertSafeUrl("http://93.184.216.34/")).resolves.toBeInstanceOf(URL);
  });

  it("takes an allow-list, with or without the colon", async () => {
    await expect(
      assertSafeUrl("ftp://93.184.216.34/", { schemes: ["ftp"] }),
    ).resolves.toBeInstanceOf(URL);
    await expect(assertSafeUrl("https://93.184.216.34/", { schemes: ["ftp:"] })).rejects.toThrow(
      UnsafeUrlError,
    );
  });

  it("rejects a string that is not a URL at all", async () => {
    expect((await rejection(assertSafeUrl("not a url"))).rule).toBe("parse");
  });
});

describe("credentials", () => {
  it("rejects userinfo by default", async () => {
    // `https://trusted.test@evil.test/` is the confusable this closes.
    const error = await rejection(assertSafeUrl("https://user:pass@93.184.216.34/"));

    expect(error.rule).toBe("credentials");
  });

  it("rejects a username with no password", async () => {
    expect((await rejection(assertSafeUrl("https://user@93.184.216.34/"))).rule).toBe(
      "credentials",
    );
  });

  it("can be opted out of", async () => {
    await expect(
      assertSafeUrl("https://user:pass@93.184.216.34/", { rejectCredentials: false }),
    ).resolves.toBeInstanceOf(URL);
  });
});

describe("private addresses", () => {
  it("rejects loopback", async () => {
    expect((await rejection(assertSafeUrl("http://127.0.0.1:8080/"))).rule).toBe("private");
    expect((await rejection(assertSafeUrl("http://[::1]/"))).rule).toBe("private");
  });

  it("rejects localhost, resolved", async () => {
    expect((await rejection(assertSafeUrl("http://localhost/"))).rule).toBe("private");
  });

  it("rejects RFC1918", async () => {
    for (const host of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.10"]) {
      expect((await rejection(assertSafeUrl(`http://${host}/`))).rule).toBe("private");
    }
  });

  it("rejects CGNAT", async () => {
    expect((await rejection(assertSafeUrl("http://100.64.0.1/"))).rule).toBe("private");
    expect((await rejection(assertSafeUrl("http://100.127.255.255/"))).rule).toBe("private");
  });

  it("rejects link-local", async () => {
    expect((await rejection(assertSafeUrl("http://169.254.1.1/"))).rule).toBe("private");
    expect((await rejection(assertSafeUrl("http://[fe80::1]/"))).rule).toBe("private");
  });

  it("rejects IPv6 unique-local", async () => {
    expect((await rejection(assertSafeUrl("http://[fd12:3456::1]/"))).rule).toBe("private");
  });

  it("rejects 0.0.0.0, which several resolvers treat as localhost", async () => {
    expect((await rejection(assertSafeUrl("http://0.0.0.0/"))).rule).toBe("private");
  });

  it("rejects an IPv4-mapped IPv6 loopback", async () => {
    // Writing the same address differently must not be a bypass.
    expect((await rejection(assertSafeUrl("http://[::ffff:127.0.0.1]/"))).rule).toBe("private");
  });

  it("rejects a NAT64-embedded private address", async () => {
    expect((await rejection(assertSafeUrl("http://[64:ff9b::a00:1]/"))).rule).toBe("private");
  });

  it("rejects a decimal and hex-spelled loopback, which URL normalises", async () => {
    expect((await rejection(assertSafeUrl("http://2130706433/"))).rule).toBe("private");
    expect((await rejection(assertSafeUrl("http://0x7f.1/"))).rule).toBe("private");
  });

  it("allows them under allowPrivate", async () => {
    await expect(
      assertSafeUrl("http://192.168.1.10/", { allowPrivate: true }),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertSafeUrl("http://127.0.0.1:9000/", { allowPrivate: true }),
    ).resolves.toBeInstanceOf(URL);
  });

  it("allows a named host without resolving it, under allowHosts", async () => {
    // The narrower escape hatch: one private target, rather than the
    // whole private space.
    await expect(
      assertSafeUrl("https://nas.invalid/files", { allowHosts: ["nas.invalid"] }),
    ).resolves.toBeInstanceOf(URL);
  });

  it("still applies the scheme rule to an allowed host", async () => {
    expect(
      (await rejection(assertSafeUrl("file://nas.invalid/x", { allowHosts: ["nas.invalid"] })))
        .rule,
    ).toBe("scheme");
  });

  it("reports the address that rejected", async () => {
    const error = await rejection(assertSafeUrl("http://10.1.2.3/"));

    expect(error.address).toBe("10.1.2.3");
    expect(error.message).toContain("10.1.2.3");
  });
});

describe("cloud metadata", () => {
  it("is rejected without allowPrivate", async () => {
    const error = await rejection(assertSafeUrl("http://169.254.169.254/latest/meta-data/"));

    expect(error.rule).toBe("metadata");
  });

  it("🚨 is rejected WITH allowPrivate too", async () => {
    // `allowPrivate: true` is the normal setting for a self-hosted app
    // talking to its own LAN, and the metadata address sits inside the
    // link-local range that opens. The exception has to survive it.
    const error = await rejection(
      assertSafeUrl("http://169.254.169.254/latest/meta-data/", { allowPrivate: true }),
    );

    expect(error.rule).toBe("metadata");
  });

  it("rejects the AWS IPv6 form, however it is spelled", async () => {
    for (const host of ["[fd00:ec2::254]", "[fd00:ec2:0:0:0:0:0:254]"]) {
      const error = await rejection(assertSafeUrl(`http://${host}/`, { allowPrivate: true }));

      expect(error.rule).toBe("metadata");
    }
  });

  it("rejects the IPv4-mapped spelling", async () => {
    const error = await rejection(
      assertSafeUrl("http://[::ffff:169.254.169.254]/", { allowPrivate: true }),
    );

    expect(error.rule).toBe("metadata");
  });
});

describe("resolveSafeAddresses", () => {
  it("returns an IP literal unchanged", async () => {
    await expect(resolveSafeAddresses("https://93.184.216.34/")).resolves.toEqual([
      "93.184.216.34",
    ]);
  });

  it("resolves a name", async () => {
    const addresses = await resolveSafeAddresses("http://localhost/", { allowPrivate: true });

    expect(addresses.length).toBeGreaterThan(0);
  });

  it("applies the policy", async () => {
    await expect(resolveSafeAddresses("http://localhost/")).rejects.toThrow(UnsafeUrlError);
  });

  it("rejects an unresolvable host on the dns rule", async () => {
    const error = await rejection(resolveSafeAddresses("https://nothing.invalid/"));

    expect(error.rule).toBe("dns");
  });
});

describe("the address predicates", () => {
  it("classify IPv4", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.255.255.255")).toBe(true);
    expect(isPrivateAddress("172.15.0.1")).toBe(false);
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
    expect(isPrivateAddress("100.63.255.255")).toBe(false);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });

  it("classify IPv6", () => {
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("::")).toBe(true);
    expect(isPrivateAddress("fc00::1")).toBe(true);
    expect(isPrivateAddress("ff02::1")).toBe(true);
    expect(isPrivateAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });

  it("treat an unparseable string as not public", () => {
    // The only safe answer: "I could not tell" must not read as "fine".
    expect(isPrivateAddress("not-an-address")).toBe(true);
  });

  it("isMetadataAddress is narrow", () => {
    expect(isMetadataAddress("169.254.169.254")).toBe(true);
    expect(isMetadataAddress("169.254.169.253")).toBe(false);
    expect(isMetadataAddress("fd00:ec2::254")).toBe(true);
    expect(isMetadataAddress("fd00:ec2::253")).toBe(false);
  });

  it("isAllowedAddress combines both rules", () => {
    expect(isAllowedAddress("93.184.216.34")).toBe(true);
    expect(isAllowedAddress("192.168.0.1")).toBe(false);
    expect(isAllowedAddress("192.168.0.1", { allowPrivate: true })).toBe(true);
    expect(isAllowedAddress("169.254.169.254", { allowPrivate: true })).toBe(false);
  });
});
