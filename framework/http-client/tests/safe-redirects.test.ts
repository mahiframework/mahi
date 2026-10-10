import { UnsafeUrlError } from "@mahiframework/core";
import { afterEach, describe, expect, it } from "vitest";
import { TooManyRedirectsError } from "../src/errors.js";
import { Http } from "../src/http.js";
import { PendingRequest } from "../src/pending-request.js";
import type { Transport } from "../src/transport.js";

afterEach(() => {
  Http.restore();
});

/**
 * A transport answering from a URL→response map, recording what it was
 * asked for.
 *
 * Every URL below is either an IP literal or a host passed through
 * `allowHosts`, so nothing here resolves a name on the network. A
 * redirect suite that needs DNS is a redirect suite that fails on a
 * train.
 */
function router(routes: Record<string, () => Response>): {
  transport: Transport;
  sent: Array<{ method: string; url: string; body: string; headers: Headers }>;
} {
  const sent: Array<{ method: string; url: string; body: string; headers: Headers }> = [];

  const transport: Transport = async (request) => {
    sent.push({
      method: request.method,
      url: request.url,
      body: await request.clone().text(),
      headers: new Headers(request.headers),
    });

    const route = routes[request.url];

    if (route === undefined) {
      throw new Error(`No route for ${request.url}`);
    }

    return route();
  };

  return { transport, sent };
}

/** A 3xx pointing at `location`. */
function redirect(status: number, location: string): () => Response {
  return () => new Response(null, { status, headers: { location } });
}

/** A terminal 200. */
function ok(body = "done"): () => Response {
  return () => new Response(body, { status: 200 });
}

const ALLOW = { allowHosts: ["a.test", "b.test", "evil.test"] };

describe("per-hop validation", () => {
  it("rejects a redirect to loopback at the hop, not after it", async () => {
    // The whole reason this exists: `fetch` follows the chain inside one
    // call, so a middleware sees only the public first URL and the
    // private target is requested before anything can object.
    const { transport, sent } = router({
      "https://a.test/start": redirect(302, "http://127.0.0.1:9/secret"),
    });

    const error = await new PendingRequest()
      .withTransport(transport)
      .withSafeRedirects(ALLOW)
      .get("https://a.test/start")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnsafeUrlError);
    expect((error as UnsafeUrlError).rule).toBe("private");
    // One request went out: the first. The private hop never did.
    expect(sent.map((entry) => entry.url)).toEqual(["https://a.test/start"]);
  });

  it("rejects a redirect to the metadata address", async () => {
    const { transport } = router({
      "https://a.test/start": redirect(302, "http://169.254.169.254/latest/meta-data/"),
    });

    const error = await new PendingRequest()
      .withTransport(transport)
      .withSafeRedirects(ALLOW)
      .get("https://a.test/start")
      .catch((e: unknown) => e);

    expect((error as UnsafeUrlError).rule).toBe("metadata");
  });

  it("rejects the metadata address even with allowPrivate", async () => {
    const { transport } = router({
      "https://a.test/start": redirect(302, "http://169.254.169.254/latest/meta-data/"),
    });

    const error = await new PendingRequest()
      .withTransport(transport)
      .withSafeRedirects({ ...ALLOW, allowPrivate: true })
      .get("https://a.test/start")
      .catch((e: unknown) => e);

    expect((error as UnsafeUrlError).rule).toBe("metadata");
  });

  it("validates the first request too", async () => {
    // A direct call to a metadata address is the same problem as a
    // redirect to one, so the first hop is not exempt.
    const { transport, sent } = router({});

    const error = await new PendingRequest()
      .withTransport(transport)
      .withSafeRedirects()
      .get("http://169.254.169.254/latest/meta-data/")
      .catch((e: unknown) => e);

    expect((error as UnsafeUrlError).rule).toBe("metadata");
    expect(sent).toHaveLength(0);
  });

  it("rejects a redirect to a disallowed scheme", async () => {
    const { transport } = router({
      "https://a.test/start": redirect(302, "file:///etc/passwd"),
    });

    const error = await new PendingRequest()
      .withTransport(transport)
      .withSafeRedirects(ALLOW)
      .get("https://a.test/start")
      .catch((e: unknown) => e);

    expect((error as UnsafeUrlError).rule).toBe("scheme");
  });

  it("reaches a private address when the policy allows it", async () => {
    const { transport } = router({
      "https://a.test/start": redirect(302, "http://192.168.1.10/thing"),
      "http://192.168.1.10/thing": ok("lan"),
    });

    const response = await new PendingRequest()
      .withTransport(transport)
      .withSafeRedirects({ ...ALLOW, allowPrivate: true })
      .get("https://a.test/start");

    expect(response.body()).toBe("lan");
  });
});

describe("the chain", () => {
  it("follows to the end and returns the terminal response", async () => {
    const { transport, sent } = router({
      "https://a.test/one": redirect(302, "https://a.test/two"),
      "https://a.test/two": redirect(302, "https://a.test/three"),
      "https://a.test/three": ok("arrived"),
    });

    const response = await new PendingRequest()
      .withTransport(transport)
      .withSafeRedirects(ALLOW)
      .get("https://a.test/one");

    expect(response.body()).toBe("arrived");
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(3);
  });

  it("resolves a relative Location against the current hop", async () => {
    const { transport } = router({
      "https://a.test/deep/one": redirect(302, "../two"),
      "https://a.test/two": ok("relative"),
    });

    const response = await new PendingRequest()
      .withTransport(transport)
      .withSafeRedirects(ALLOW)
      .get("https://a.test/deep/one");

    expect(response.body()).toBe("relative");
  });

  it("stops at the hop cap", async () => {
    const { transport, sent } = router({
      "https://a.test/loop": redirect(302, "https://a.test/loop"),
    });

    const error = await new PendingRequest()
      .withTransport(transport)
      .withSafeRedirects({ ...ALLOW, maxRedirects: 2 })
      .get("https://a.test/loop")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TooManyRedirectsError);
    expect((error as TooManyRedirectsError).maxRedirects).toBe(2);
    expect((error as TooManyRedirectsError).chain.length).toBeGreaterThan(2);
    // Cap reached means the capped request is not made.
    expect(sent).toHaveLength(3);
  });

  it("returns a 3xx carrying no Location rather than failing", async () => {
    // There is nowhere to go, so the status is the answer.
    const { transport } = router({
      "https://a.test/start": () => new Response(null, { status: 302 }),
    });

    const response = await new PendingRequest()
      .withTransport(transport)
      .withSafeRedirects(ALLOW)
      .get("https://a.test/start");

    expect(response.status).toBe(302);
  });

  it("does not treat a 304 as a redirect", async () => {
    // 304 means the cached copy stands, not "ask elsewhere".
    const { transport, sent } = router({
      "https://a.test/cached": () =>
        new Response(null, { status: 304, headers: { location: "https://a.test/other" } }),
    });

    const response = await new PendingRequest()
      .withTransport(transport)
      .withSafeRedirects(ALLOW)
      .get("https://a.test/cached");

    expect(response.status).toBe(304);
    expect(sent).toHaveLength(1);
  });

  it("records every hop", async () => {
    Http.fake({
      "a.test/one": Http.response(null, 302, { location: "https://a.test/two" }),
      "a.test/two": Http.response("end"),
    });

    await Http.withSafeRedirects(ALLOW).get("https://a.test/one");

    Http.assertSentCount(2);
    Http.assertSentInOrder(["a.test/one", "a.test/two"]);
  });
});

describe("method and body across a hop", () => {
  it("replays the body on a 307", async () => {
    const { transport, sent } = router({
      "https://a.test/post": redirect(307, "https://a.test/final"),
      "https://a.test/final": ok(),
    });

    await new PendingRequest()
      .withTransport(transport)
      .withSafeRedirects(ALLOW)
      .post("https://a.test/post", { name: "Ada" });

    expect(sent[1]?.method).toBe("POST");
    expect(sent[1]?.body).toBe(JSON.stringify({ name: "Ada" }));
  });

  it("replays the body on a 308", async () => {
    const { transport, sent } = router({
      "https://a.test/post": redirect(308, "https://a.test/final"),
      "https://a.test/final": ok(),
    });

    await new PendingRequest()
      .withTransport(transport)
      .withSafeRedirects(ALLOW)
      .put("https://a.test/post", { name: "Ada" });

    expect(sent[1]?.method).toBe("PUT");
    expect(sent[1]?.body).toBe(JSON.stringify({ name: "Ada" }));
  });

  it("rewrites a 303 to GET and drops the body", async () => {
    // The entire purpose of 303: "your POST was accepted, now GET the
    // result". Replaying the body would re-submit it.
    const { transport, sent } = router({
      "https://a.test/post": redirect(303, "https://a.test/result"),
      "https://a.test/result": ok(),
    });

    await new PendingRequest()
      .withTransport(transport)
      .withSafeRedirects(ALLOW)
      .post("https://a.test/post", { name: "Ada" });

    expect(sent[1]?.method).toBe("GET");
    expect(sent[1]?.body).toBe("");
    expect(sent[1]?.headers.get("content-type")).toBeNull();
  });

  it("rewrites a POST to GET on a 301 and a 302", async () => {
    for (const status of [301, 302]) {
      const { transport, sent } = router({
        "https://a.test/post": redirect(status, "https://a.test/result"),
        "https://a.test/result": ok(),
      });

      await new PendingRequest()
        .withTransport(transport)
        .withSafeRedirects(ALLOW)
        .post("https://a.test/post", { name: "Ada" });

      expect(sent[1]?.method).toBe("GET");
    }
  });

  it("keeps a PUT on a 301", async () => {
    // The POST→GET rewrite is historical and specific to POST.
    const { transport, sent } = router({
      "https://a.test/put": redirect(301, "https://a.test/final"),
      "https://a.test/final": ok(),
    });

    await new PendingRequest()
      .withTransport(transport)
      .withSafeRedirects(ALLOW)
      .put("https://a.test/put", { name: "Ada" });

    expect(sent[1]?.method).toBe("PUT");
  });

  it("refuses to replay a streaming body", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("streamed"));
        controller.close();
      },
    });

    const { transport } = router({
      "https://a.test/post": redirect(307, "https://a.test/final"),
      "https://a.test/final": ok(),
    });

    const error = await new PendingRequest()
      .withTransport(transport)
      .withSafeRedirects(ALLOW)
      .withBody(stream)
      .post("https://a.test/post")
      .catch((e: unknown) => e);

    expect((error as Error).message).toContain("can only be sent once");
  });
});

describe("credentials across a hop", () => {
  it("keeps Authorization on a same-host hop", async () => {
    const { transport, sent } = router({
      "https://a.test/one": redirect(302, "https://a.test/two"),
      "https://a.test/two": ok(),
    });

    await new PendingRequest()
      .withTransport(transport)
      .withSafeRedirects(ALLOW)
      .withToken("secret")
      .get("https://a.test/one");

    expect(sent[1]?.headers.get("authorization")).toBe("Bearer secret");
  });

  it("drops Authorization and Cookie when the host changes", async () => {
    // A redirect is chosen by the server being redirected away from, so
    // carrying credentials across the hop hands them to whoever it names.
    const { transport, sent } = router({
      "https://a.test/one": redirect(302, "https://evil.test/two"),
      "https://evil.test/two": ok(),
    });

    await new PendingRequest()
      .withTransport(transport)
      .withSafeRedirects(ALLOW)
      .withToken("secret")
      .withCookies({ session: "abc" })
      .get("https://a.test/one");

    expect(sent[0]?.headers.get("authorization")).toBe("Bearer secret");
    expect(sent[1]?.headers.get("authorization")).toBeNull();
    expect(sent[1]?.headers.get("cookie")).toBeNull();
  });
});

describe("without withSafeRedirects", () => {
  it("nothing is validated and the chain is the transport's business", async () => {
    // The default path is unchanged: one call into the transport, which
    // follows redirects itself.
    const { transport, sent } = router({
      "http://169.254.169.254/latest/meta-data/": ok("leak"),
    });

    const response = await new PendingRequest()
      .withTransport(transport)
      .get("http://169.254.169.254/latest/meta-data/");

    expect(response.body()).toBe("leak");
    expect(sent).toHaveLength(1);
  });
});
