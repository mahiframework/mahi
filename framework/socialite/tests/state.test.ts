import { createHash, randomBytes } from "node:crypto";
import { Signer } from "@mahiframework/encryption";
import { describe, expect, it } from "vitest";
import { InvalidStateError } from "../src/errors.js";
import {
  assertStateMatches,
  codeChallenge,
  constantTimeEquals,
  pullState,
  queueState,
  randomToken,
  stateCookieName,
} from "../src/state.js";
import { callbackRequest, queuedCookies, redirectRequest } from "./__fixtures__/test-app.js";

function signer(): Signer {
  return new Signer(randomBytes(32)).for("socialite");
}

const COOKIE = { secure: false };

describe("randomToken", () => {
  it("is base64url, so it is a legal PKCE verifier", () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("is 43 characters at 32 bytes, inside RFC 7636's 43-128 range", () => {
    expect(randomToken().length).toBe(43);
  });

  it("does not repeat", () => {
    expect(randomToken()).not.toBe(randomToken());
  });
});

describe("codeChallenge", () => {
  it("is the unpadded base64url SHA-256 of the verifier", () => {
    const verifier = "a-known-verifier";
    const expected = createHash("sha256").update(verifier).digest("base64url");

    expect(codeChallenge(verifier)).toBe(expected);
    expect(codeChallenge(verifier)).not.toContain("=");
  });

  // RFC 7636 appendix B's published vector, which pins the whole chain:
  // UTF-8 bytes, SHA-256, base64url, no padding.
  it("matches RFC 7636 appendix B", () => {
    expect(codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("the state cookie", () => {
  it("round-trips through a queue and a pull", () => {
    const keys = signer();
    const redirect = redirectRequest();

    queueState(redirect, keys, { provider: "github", state: "s", verifier: "v" }, COOKIE);

    const callback = callbackRequest({}, queuedCookies(redirect));
    const pulled = pullState(callback, keys, "github", COOKIE);

    expect(pulled.ok).toBe(true);
    expect(pulled.ok && pulled.state).toEqual({
      provider: "github",
      state: "s",
      verifier: "v",
      nonce: null,
    });
  });

  it("carries an OIDC nonce when one was queued", () => {
    const keys = signer();
    const redirect = redirectRequest();

    queueState(redirect, keys, { provider: "work", state: "s", verifier: "v", nonce: "n" }, COOKIE);

    const pulled = pullState(callbackRequest({}, queuedCookies(redirect)), keys, "work", COOKIE);

    expect(pulled.ok && pulled.state.nonce).toBe("n");
  });

  it("is named per provider, so concurrent flows do not collide", () => {
    const keys = signer();
    const redirect = redirectRequest();

    queueState(redirect, keys, { provider: "github", state: "g", verifier: null }, COOKIE);
    queueState(redirect, keys, { provider: "gitlab", state: "l", verifier: null }, COOKIE);

    const callback = callbackRequest({}, queuedCookies(redirect));

    const github = pullState(callback, keys, "github", COOKIE);
    const gitlab = pullState(callback, keys, "gitlab", COOKIE);

    expect(github.ok && github.state.state).toBe("g");
    expect(gitlab.ok && gitlab.state.state).toBe("l");
  });

  it("is httpOnly and SameSite=Lax", () => {
    const redirect = redirectRequest();

    queueState(redirect, signer(), { provider: "github", state: "s", verifier: null }, COOKIE);

    const header = redirect.queuedCookieHeaders()[0] ?? "";

    expect(header).toContain("HttpOnly");
    // Load-bearing: `Strict` withholds the cookie on the cross-site
    // top-level GET an OAuth callback is, so every login would fail.
    expect(header).toContain("SameSite=Lax");
  });

  it("carries a Max-Age, so an abandoned flow leaves nothing behind", () => {
    const redirect = redirectRequest();

    queueState(
      redirect,
      signer(),
      { provider: "github", state: "s", verifier: null },
      { ...COOKIE, ttlSeconds: 300 },
    );

    expect(redirect.queuedCookieHeaders()[0]).toContain("Max-Age=300");
  });

  it("queues the cookie's deletion on a pull, making it single-use", () => {
    const keys = signer();
    const redirect = redirectRequest();

    queueState(redirect, keys, { provider: "github", state: "s", verifier: null }, COOKIE);

    const callback = callbackRequest({}, queuedCookies(redirect));
    pullState(callback, keys, "github", COOKIE);

    expect(queuedCookies(callback)[stateCookieName("github")]).toBeUndefined();
  });

  it("reports `missing` when there is no cookie", () => {
    const pulled = pullState(callbackRequest(), signer(), "github", COOKIE);

    expect(pulled).toEqual({ ok: false, reason: "missing" });
  });

  it("reports `unsigned` for a cookie signed with a different key", () => {
    const redirect = redirectRequest();

    queueState(redirect, signer(), { provider: "github", state: "s", verifier: null }, COOKIE);

    const callback = callbackRequest({}, queuedCookies(redirect));
    // A different app key entirely, which is also what a rotated-out key
    // looks like from here.
    const pulled = pullState(callback, signer(), "github", COOKIE);

    expect(pulled).toEqual({ ok: false, reason: "unsigned" });
  });

  it("reports `unsigned` for a tampered payload", () => {
    const keys = signer();
    const redirect = redirectRequest();

    queueState(redirect, keys, { provider: "github", state: "s", verifier: null }, COOKIE);

    const jar = queuedCookies(redirect);
    const name = stateCookieName("github");
    const original = jar[name] ?? "";

    const callback = callbackRequest({}, { [name]: `${original}tampered` });

    expect(pullState(callback, keys, "github", COOKIE)).toEqual({
      ok: false,
      reason: "unsigned",
    });
  });

  it("reports `unsigned` when a verified payload is not decodable state", () => {
    const keys = signer();
    // Signed by this server, but not a payload this version wrote — what
    // a shape change across a deploy looks like.
    const callback = callbackRequest({}, { [stateCookieName("github")]: keys.sign("not-json") });

    expect(pullState(callback, keys, "github", COOKIE)).toEqual({
      ok: false,
      reason: "unsigned",
    });
  });
});

describe("assertStateMatches", () => {
  const stashed = { provider: "github", state: "issued", verifier: "v" };

  it("returns the stashed state when everything matches", () => {
    expect(assertStateMatches("github", { ok: true, state: stashed }, "issued")).toBe(stashed);
  });

  it("surfaces the pull's reason", () => {
    for (const reason of ["missing", "unsigned"] as const) {
      try {
        assertStateMatches("github", { ok: false, reason }, "issued");
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidStateError);
        expect((error as InvalidStateError).reason).toBe(reason);
      }
    }
  });

  it("rejects a cookie minted for a different provider", () => {
    try {
      assertStateMatches(
        "gitlab",
        { ok: true, state: { ...stashed, provider: "github" } },
        "issued",
      );
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as InvalidStateError).reason).toBe("wrong-provider");
    }
  });

  it("rejects a state that does not match", () => {
    try {
      assertStateMatches("github", { ok: true, state: stashed }, "something-else");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as InvalidStateError).reason).toBe("mismatch");
    }
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
  ])("rejects an %s presented state", (_label, presented) => {
    try {
      assertStateMatches("github", { ok: true, state: stashed }, presented);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as InvalidStateError).reason).toBe("mismatch");
    }
  });

  it("rejects a stateless cookie against a presented state", () => {
    try {
      assertStateMatches("github", { ok: true, state: { ...stashed, state: null } }, "issued");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as InvalidStateError).reason).toBe("mismatch");
    }
  });
});

describe("constantTimeEquals", () => {
  it("matches equal strings", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
  });

  it("rejects different strings of the same length", () => {
    expect(constantTimeEquals("abc", "abd")).toBe(false);
  });

  // `timingSafeEqual` throws on mismatched lengths, so this would be an
  // exception rather than a `false` without the length guard.
  it("rejects different lengths without throwing", () => {
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
    expect(constantTimeEquals("", "a")).toBe(false);
  });
});
