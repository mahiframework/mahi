import { afterEach, describe, expect, it } from "vitest";
import { ConnectionError, StrayRequestError } from "../src/errors.js";
import { Http } from "../src/http.js";
import { urlMatch } from "../src/matching.js";

afterEach(() => {
  Http.restore();
});

describe("fake() forms", () => {
  it("with no arguments answers every request with an empty 200", async () => {
    Http.fake();
    const response = await Http.get("https://anything.test/at/all");
    expect(response.status).toBe(200);
    expect(response.body()).toBe("");
  });

  it("accepts a single handler for everything", async () => {
    Http.fake((request) => ({ echoed: request.url }));
    expect((await Http.get("https://x.test/a")).json("echoed")).toBe("https://x.test/a");
  });

  it("accepts a pattern map", async () => {
    Http.fake({
      "github.com/*": { source: "github" },
      "gitlab.com/*": { source: "gitlab" },
    });

    expect((await Http.get("https://api.github.com/user")).json("source")).toBe("github");
    expect((await Http.get("https://gitlab.com/api/v4/user")).json("source")).toBe("gitlab");
  });

  it("accepts a sequence as a pattern's value", async () => {
    Http.fake({ "x.test/*": Http.sequence().pushStatus(500).push({ ok: true }) });

    expect((await Http.get("https://x.test/a")).status).toBe(500);
    expect((await Http.get("https://x.test/a")).json("ok")).toBe(true);
  });

  it("replaces stubs rather than accumulating across calls", async () => {
    Http.fake({ "x.test/*": { first: true } });
    Http.fake({ "x.test/*": { second: true } });

    // Laravel's ->merge() composes the two in a surprising order; here the
    // second call is simply the configuration.
    expect((await Http.get("https://x.test/a")).json("second")).toBe(true);
  });
});

describe("stub response coercions", () => {
  it("treats a number as a status code", async () => {
    Http.fake({ "*": 503 });
    const response = await Http.get("https://x.test/");
    expect(response.status).toBe(503);
    expect(response.body()).toBe("");
  });

  it("rejects a number outside 100-599, pointing at the body form", async () => {
    Http.fake({ "*": 42 });
    await expect(Http.get("https://x.test/")).rejects.toThrow(/between 100 and 599/);
  });

  it("treats a string as a raw body with a 200", async () => {
    Http.fake({ "*": "plain text" });
    const response = await Http.get("https://x.test/");
    expect(response.status).toBe(200);
    expect(response.body()).toBe("plain text");
  });

  it("treats an object as a JSON body with the JSON content type", async () => {
    Http.fake({ "*": { id: 1 } });
    const response = await Http.get("https://x.test/");
    expect(response.header("content-type")).toBe("application/json");
    expect(response.json("id")).toBe(1);
  });

  it("treats an array as a JSON body", async () => {
    Http.fake({ "*": [1, 2, 3] });
    expect((await Http.get("https://x.test/")).json()).toEqual([1, 2, 3]);
  });

  it("honours the explicit { body, status, headers } form", async () => {
    Http.fake({ "*": { body: { id: 1 }, status: 201, headers: { "X-Custom": "yes" } } });
    const response = await Http.get("https://x.test/");
    expect(response.status).toBe(201);
    expect(response.header("x-custom")).toBe("yes");
    expect(response.json("id")).toBe(1);
  });

  it("does not mistake a JSON payload with a `status` key for the spec form", async () => {
    // { status: "active", name: "Ada" } has a non-spec key, so it is a body.
    Http.fake({ "*": { status: "active", name: "Ada" } });
    const response = await Http.get("https://x.test/");
    expect(response.status).toBe(200);
    expect(response.json("status")).toBe("active");
  });

  it("treats a lone non-numeric `status` as a JSON body, not a spec", async () => {
    // `{ status: "active" }` has only a spec-shaped key, but a string is
    // never an HTTP status, so it is a JSON body, not `status: NaN`.
    Http.fake({ "*": { status: "active" } });
    const response = await Http.get("https://x.test/");
    expect(response.status).toBe(200);
    expect(response.json("status")).toBe("active");
  });

  it("Http.response() builds a stub explicitly", async () => {
    Http.fake({ "*": Http.response({ id: 7 }, 202, { "X-A": "1" }) });
    const response = await Http.get("https://x.test/");
    expect(response.status).toBe(202);
    expect(response.header("x-a")).toBe("1");
    expect(response.json("id")).toBe(7);
  });

  it("uses a Response stub verbatim", async () => {
    Http.fake({ "*": new Response("hi", { status: 201, headers: { "X-A": "1" } }) });
    const response = await Http.get("https://x.test/");
    expect(response.status).toBe(201);
    expect(response.header("x-a")).toBe("1");
    expect(response.body()).toBe("hi");
  });

  it("reuses a Response stub across multiple requests", async () => {
    // A Response body reads once; the stub must be cloned per call, or the
    // second request throws "Body is unusable".
    Http.fake({ "*": new Response("hi") });
    expect((await Http.get("https://x.test/a")).body()).toBe("hi");
    expect((await Http.get("https://x.test/b")).body()).toBe("hi");
  });

  it("Http.failedConnection() surfaces as a ConnectionError", async () => {
    Http.fake({ "*": Http.failedConnection("network down") });
    await expect(Http.get("https://x.test/")).rejects.toThrow(ConnectionError);
    await expect(Http.get("https://x.test/")).rejects.toThrow(/network down/);
  });
});

describe("wildcard matching", () => {
  const cases: Array<[pattern: string, url: string, expected: boolean]> = [
    // The implicit leading `*`, Laravel's Str::start($url, '*').
    ["github.com/*", "https://api.github.com/repos", true],
    ["github.com/*", "https://gitlab.com/repos", false],
    ["*", "https://anything.test/", true],
    ["https://x.test/users", "https://x.test/users", true],
    ["https://x.test/users", "https://x.test/users/1", false],
    ["x.test/users/*", "https://x.test/users/1", true],
    ["x.test/*/comments", "https://x.test/posts/comments", true],
    ["x.test/*/comments", "https://x.test/posts/1/comments", true],
    // Anchored at both ends: a trailing segment must be matched explicitly.
    ["x.test/users", "https://x.test/users?page=1", false],
    ["x.test/users*", "https://x.test/users?page=1", true],
    // Regex metacharacters in the pattern are literal.
    ["x.test/a.b", "https://x.test/aXb", false],
    ["x.test/a.b", "https://x.test/a.b", true],
  ];

  it.each(cases)("urlMatch(%j, %j) === %s", (pattern, url, expected) => {
    expect(urlMatch(pattern, url)).toBe(expected);
  });
});

describe("stub resolution order", () => {
  it("first match wins", async () => {
    Http.fake({
      "x.test/*": { which: "specific" },
      "*": { which: "catchall" },
    });
    expect((await Http.get("https://x.test/a")).json("which")).toBe("specific");
  });

  it("a handler returning undefined declines to the next stub", async () => {
    Http.fake({
      "x.test/*": (request) =>
        request.url.endsWith("/special") ? { which: "handler" } : undefined,
      "*": { which: "fallback" },
    });

    expect((await Http.get("https://x.test/special")).json("which")).toBe("handler");
    expect((await Http.get("https://x.test/other")).json("which")).toBe("fallback");
  });

  it("a handler can branch on the decoded payload", async () => {
    Http.fake({
      "*": (request) => ({ receivedName: (request.data() as { name?: string })?.name }),
    });

    const response = await Http.post("https://x.test/users", { name: "Ada" });
    expect(response.json("receivedName")).toBe("Ada");
  });
});

describe("stray requests", () => {
  it("raises StrayRequestError naming the method and URL", async () => {
    Http.fake({ "github.com/*": { ok: true } });

    await expect(Http.post("https://api.example.com/users")).rejects.toThrow(StrayRequestError);
    await expect(Http.post("https://api.example.com/users")).rejects.toThrow(
      /POST https:\/\/api\.example\.com\/users/,
    );
  });

  it("never lets the 555 marker escape as a ClientResponse", async () => {
    Http.fake({ "github.com/*": { ok: true } });

    const caught = await Http.get("https://unmatched.test/").catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(StrayRequestError);
    // If the synthesised response ever leaked, this is where it would show.
    expect(caught).not.toHaveProperty("status");
  });

  it("still records the attempt, so assertSent works on an unstubbed request", async () => {
    Http.fake({ "github.com/*": { ok: true } });
    await Http.get("https://typo.test/users").catch(() => undefined);

    // Precisely what you want when debugging why a pattern didn't match.
    Http.assertSent("typo.test/users");
    expect(Http.recorded()).toHaveLength(1);
  });

  it("is not suppressed by middleware that swallows errors", async () => {
    Http.fake({ "github.com/*": { ok: true } });

    // The reason a 555 response is carried back out instead of thrown at
    // the miss site: a throw there would unwind through this pipe, and a
    // loud test failure would become a silent pass.
    const swallowing = Http.withMiddleware(async (request, next) => {
      try {
        return await next(request);
      } catch {
        return next(request);
      }
    });

    await expect(swallowing.get("https://unmatched.test/")).rejects.toThrow(StrayRequestError);
  });

  it("is not caught as a ConnectionError", async () => {
    Http.fake({ "github.com/*": { ok: true } });

    const caught = await Http.get("https://unmatched.test/").catch((error: unknown) => error);
    // Application code catching its own client errors must not swallow a
    // test-harness failure.
    expect(caught).not.toBeInstanceOf(ConnectionError);
    expect(caught).toBeInstanceOf(StrayRequestError);
  });

  it("allowStrayRequests() with no patterns lets misses through", async () => {
    Http.fake({ "github.com/*": { ok: true } });
    Http.allowStrayRequests();

    // Proven without touching the network by swapping the transport: the
    // request reaches it, which is what "not refused" means.
    let reached = false;
    const response = await Http.withTransport(async () => {
      reached = true;

      return new Response("from transport", { status: 200 });
    }).get("https://unmatched.test/");

    expect(reached).toBe(true);
    expect(response.body()).toBe("from transport");
  });

  it("allowStrayRequests(patterns) only lets matching URLs through", async () => {
    Http.fake({ "github.com/*": { ok: true } });
    Http.allowStrayRequests(["*localhost*"]);

    await expect(Http.get("https://elsewhere.test/")).rejects.toThrow(StrayRequestError);
  });

  it("allow-list patterns have no implicit leading wildcard", async () => {
    Http.fake({ "github.com/*": { ok: true } });
    // Unlike a stub pattern, this does NOT match https://api.example.com/x,
    // an explicit escape from the guard is spelled out in full.
    Http.allowStrayRequests(["api.example.com/*"]);

    await expect(Http.get("https://api.example.com/x")).rejects.toThrow(StrayRequestError);
  });

  it("restore() clears the stray guard along with everything else", async () => {
    Http.fake({ "*": { ok: true } });
    Http.allowStrayRequests();
    Http.restore();

    expect(Http.isFaked()).toBe(false);
    expect(Http.recorded()).toHaveLength(0);
  });
});

describe("ResponseSequence", () => {
  it("drains FIFO", async () => {
    Http.fake({ "*": Http.sequence().push({ n: 1 }).push({ n: 2 }).push({ n: 3 }) });

    expect((await Http.get("https://x.test/")).json("n")).toBe(1);
    expect((await Http.get("https://x.test/")).json("n")).toBe(2);
    expect((await Http.get("https://x.test/")).json("n")).toBe(3);
  });

  it("pushStatus queues a bare status", async () => {
    Http.fake({ "*": Http.sequence().pushStatus(429, { "Retry-After": "1" }) });
    const response = await Http.get("https://x.test/");
    expect(response.status).toBe(429);
    expect(response.header("retry-after")).toBe("1");
  });

  it("pushFile queues a file's contents, read at drain time", async () => {
    const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = await mkdtemp(join(tmpdir(), "mahi-http-"));
    const path = join(dir, "fixture.json");
    await writeFile(path, '{"from":"file"}');

    Http.fake({ "*": Http.sequence().pushFile(path) });
    expect((await Http.get("https://x.test/")).json("from")).toBe("file");

    await rm(dir, { recursive: true, force: true });
  });

  it("pushFailedConnection queues a transport failure", async () => {
    Http.fake({ "*": Http.sequence().pushFailedConnection("dropped") });
    await expect(Http.get("https://x.test/")).rejects.toThrow(ConnectionError);
  });

  it("throws when drained empty", async () => {
    Http.fake({ "*": Http.sequence().push({ n: 1 }) });
    await Http.get("https://x.test/");

    await expect(Http.get("https://x.test/")).rejects.toThrow(/sequence is empty/);
  });

  it("dontFailWhenEmpty answers 200 instead of throwing", async () => {
    Http.fake({ "*": Http.sequence().push({ n: 1 }).dontFailWhenEmpty() });
    await Http.get("https://x.test/");

    expect((await Http.get("https://x.test/")).status).toBe(200);
  });

  it("whenEmpty answers with the given response", async () => {
    Http.fake({ "*": Http.sequence().push({ n: 1 }).whenEmpty({ drained: true }) });
    await Http.get("https://x.test/");

    expect((await Http.get("https://x.test/")).json("drained")).toBe(true);
  });

  it("assertSequencesAreEmpty passes when drained and fails when not", async () => {
    Http.fake({ "x.test/*": Http.sequence().push({ n: 1 }).push({ n: 2 }) });

    await Http.get("https://x.test/");
    expect(() => Http.assertSequencesAreEmpty()).toThrow(
      'Expected the response sequence for "x.test/*" to be empty, but it is not.',
    );

    await Http.get("https://x.test/");
    expect(() => Http.assertSequencesAreEmpty()).not.toThrow();
  });
});

describe("assertions", () => {
  it("assertSent passes on a match and fails with an actionable message", async () => {
    Http.fake();
    await Http.get("https://x.test/users");

    expect(() => Http.assertSent("x.test/users")).not.toThrow();
    expect(() => Http.assertSent("x.test/posts")).toThrow(
      'Expected a request matching "x.test/posts" to have been sent. Sent: GET https://x.test/users',
    );
  });

  it("assertSent accepts a predicate over the request and response", async () => {
    Http.fake({ "*": { id: 1 } });
    await Http.post("https://x.test/users", { name: "Ada" });

    Http.assertSent((request) => (request.data() as { name: string }).name === "Ada");
    Http.assertSent((request, response) => request.method === "POST" && response?.status === 200);
    expect(() => Http.assertSent(() => false)).toThrow(/the given predicate/);
  });

  it("assertNotSent passes when nothing matched and fails when something did", async () => {
    Http.fake();
    await Http.get("https://x.test/users");

    expect(() => Http.assertNotSent("x.test/posts")).not.toThrow();
    expect(() => Http.assertNotSent("x.test/users")).toThrow(
      'Expected no request matching "x.test/users" to have been sent, but 1 was. ' +
        "Sent: GET https://x.test/users",
    );
  });

  it("assertSentInOrder passes in order and fails out of order", async () => {
    Http.fake();
    await Http.get("https://x.test/a");
    await Http.get("https://x.test/b");
    await Http.get("https://x.test/c");

    expect(() => Http.assertSentInOrder(["x.test/a", "x.test/c"])).not.toThrow();
    expect(() => Http.assertSentInOrder(["x.test/c", "x.test/a"])).toThrow(
      /to have been sent in order at position 4 or later/,
    );
  });

  it("assertSentCount checks the exact total", async () => {
    Http.fake();
    await Http.get("https://x.test/a");
    await Http.get("https://x.test/b");

    expect(() => Http.assertSentCount(2)).not.toThrow();
    expect(() => Http.assertSentCount(3)).toThrow(
      "Expected 3 request(s) to have been sent, but 2 were. " +
        "Sent: GET https://x.test/a, GET https://x.test/b",
    );
  });

  it("assertNothingSent passes on a clean slate and fails otherwise", async () => {
    Http.fake();
    expect(() => Http.assertNothingSent()).not.toThrow();

    await Http.get("https://x.test/a");
    expect(() => Http.assertNothingSent()).toThrow(
      "Expected no requests to have been sent, but 1 were. Sent: GET https://x.test/a",
    );
  });

  it("assertions throw plain Errors, not test-runner matchers", async () => {
    Http.fake();
    const caught = (() => {
      try {
        Http.assertSent("nope");
      } catch (error) {
        return error;
      }
    })();

    expect(caught).toBeInstanceOf(Error);
    expect(caught?.constructor).toBe(Error);
  });
});

describe("recorded()", () => {
  it("returns pairs oldest first", async () => {
    Http.fake({ "*": { ok: true } });
    await Http.get("https://x.test/a");
    await Http.post("https://x.test/b", { n: 1 });

    const recorded = Http.recorded();
    expect(recorded).toHaveLength(2);
    expect(recorded[0]![0].url).toBe("https://x.test/a");
    expect(recorded[1]![0].method).toBe("POST");
    expect(recorded[1]![1]?.json("ok")).toBe(true);
  });

  it("filters with a predicate", async () => {
    Http.fake();
    await Http.get("https://x.test/a");
    await Http.post("https://x.test/b");

    expect(Http.recorded((request) => request.method === "POST")).toHaveLength(1);
  });

  it("is cleared by a new fake()", async () => {
    Http.fake();
    await Http.get("https://x.test/a");
    expect(Http.recorded()).toHaveLength(1);

    Http.fake();
    expect(Http.recorded()).toHaveLength(0);
  });
});

describe("isFaked", () => {
  it("reflects the fake state", () => {
    expect(Http.isFaked()).toBe(false);
    Http.fake();
    expect(Http.isFaked()).toBe(true);
    Http.restore();
    expect(Http.isFaked()).toBe(false);
  });
});
