import { mkdtemp, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  HttpResponse,
  JsonResponse,
  FileResponse,
  RedirectResponse,
  toWebResponse,
} from "../src/response.js";
import { Router } from "../src/router.js";
import type { HttpPipe } from "../src/middleware/pipeline-middleware.js";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
}

describe("Response (base)", () => {
  it("builds directly with content/status and exposes setContent/getContent", async () => {
    const res = new HttpResponse("hello", 201);
    expect(res.getContent()).toBe("hello");
    expect(res.getStatus()).toBe(201);

    res.setContent("world");
    expect(res.getContent()).toBe("world");

    const web = await res.toWeb();
    expect(web.status).toBe(201);
    expect(await web.text()).toBe("world");
  });

  it("has fluent header()/status()/withHeaders() that return this", () => {
    const res = new HttpResponse();
    expect(res.header("X-One", "1")).toBe(res);
    expect(res.status(418)).toBe(res);
    expect(res.withHeaders({ "X-Two": "2", "X-Three": "3" })).toBe(res);

    expect(res.getStatus()).toBe(418);
    expect(res.getHeader("X-One")).toBe("1");
    expect(res.getHeader("X-Two")).toBe("2");
    expect(res.getHeader("X-Three")).toBe("3");
  });
});

describe("Response.json / JsonResponse", () => {
  it("is a JsonResponse and round-trips the value via getJson/setJson", () => {
    const res = HttpResponse.json({ ok: true }, 201);
    expect(res).toBeInstanceOf(JsonResponse);
    expect(res.getJson()).toEqual({ ok: true });

    res.setJson({ ok: false });
    expect(res.getJson()).toEqual({ ok: false });
  });

  it("toWeb() serializes JSON with content-type, status and custom headers", async () => {
    const res = HttpResponse.json({ hi: "there" }, 202).header("X-Custom", "yes");
    const web = await res.toWeb();

    expect(web.status).toBe(202);
    expect(web.headers.get("Content-Type")).toContain("application/json");
    expect(web.headers.get("X-Custom")).toBe("yes");
    expect(await web.json()).toEqual({ hi: "there" });
  });
});

describe("Response.html", () => {
  it("sets a utf-8 html content type", async () => {
    const web = await HttpResponse.html("<p>hi</p>").toWeb();

    expect(web.status).toBe(200);
    // Explicit charset: the historical default for `text/html` is
    // ISO-8859-1, which mangles anything non-ASCII.
    expect(web.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await web.text()).toBe("<p>hi</p>");
  });

  it("takes a status and extra headers", async () => {
    const web = await HttpResponse.html("<p>nope</p>", 404, { "X-Custom": "yes" }).toWeb();

    expect(web.status).toBe(404);
    expect(web.headers.get("X-Custom")).toBe("yes");
  });

  it("lets a caller override the content type", async () => {
    const web = await HttpResponse.html("<p>hi</p>", 200, {
      "Content-Type": "application/xhtml+xml",
    }).toWeb();

    expect(web.headers.get("Content-Type")).toBe("application/xhtml+xml");
  });

  it("does not escape — escaping is the caller's job", async () => {
    // Deliberate: this is a transport helper, not a template engine.
    // Every interpolation at the call site goes through `Str.escapeHtml`.
    const web = await HttpResponse.html("<p>a & b</p>").toWeb();

    expect(await web.text()).toBe("<p>a & b</p>");
  });
});

describe("Response.redirect / RedirectResponse", () => {
  it("defaults to 302 with a Location header and round-trips the url", () => {
    const res = HttpResponse.redirect("/login");
    expect(res).toBeInstanceOf(RedirectResponse);
    expect(res.getStatus()).toBe(302);
    expect(res.getRedirectUrl()).toBe("/login");
    expect(res.getHeader("Location")).toBe("/login");

    res.setRedirectUrl("/dashboard");
    expect(res.getRedirectUrl()).toBe("/dashboard");
    expect(res.getHeader("Location")).toBe("/dashboard");
  });

  it("honors a custom status and produces a bodyless web response", async () => {
    const res = HttpResponse.redirect("/moved", 301);
    const web = await res.toWeb();
    expect(web.status).toBe(301);
    expect(web.headers.get("Location")).toBe("/moved");
  });
});

describe("Response.file / FileResponse", () => {
  it("serves a filesystem path with derived content-type and length", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resp-"));
    const path = join(dir, "note.txt");
    await writeFile(path, "file body");

    const res = HttpResponse.file(path);
    expect(res).toBeInstanceOf(FileResponse);

    const web = await res.toWeb();
    expect(web.headers.get("Content-Type")).toBe("text/plain");
    expect(web.headers.get("Content-Length")).toBe(String("file body".length));
    expect(await web.text()).toBe("file body");
  });

  it("download(filename) sets Content-Disposition attachment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resp-"));
    const path = join(dir, "report.pdf");
    await writeFile(path, "%PDF-1.4");

    const web = await HttpResponse.file(path).download("statement.pdf").toWeb();
    expect(web.headers.get("Content-Type")).toBe("application/pdf");
    expect(web.headers.get("Content-Disposition")).toBe('attachment; filename="statement.pdf"');
  });

  it("escapes a quote in the filename instead of letting it break out of the header", async () => {
    // Filenames routinely come from user input (an upload, a
    // user-titled export). Interpolated raw, a `"` closes the quoted
    // string early and everything after it becomes header parameters.
    const web = await HttpResponse.file(new File(["x"], "x.txt"))
      .download('evil".pdf')
      .toWeb();

    const disposition = web.headers.get("Content-Disposition")!;
    expect(disposition).toBe(`attachment; filename="evil_.pdf"; filename*=UTF-8''evil%22.pdf`);
  });

  it("adds an RFC 5987 filename* for a non-ASCII name", async () => {
    const web = await HttpResponse.file(new File(["x"], "x.txt"))
      .download("rapport-café.pdf")
      .toWeb();

    expect(web.headers.get("Content-Disposition")).toBe(
      `attachment; filename="rapport-caf_.pdf"; filename*=UTF-8''rapport-caf%C3%A9.pdf`,
    );
  });

  it("collapses path separators so a filename can't suggest a path", async () => {
    const web = await HttpResponse.file(new File(["x"], "x.txt"))
      .download("../../etc/passwd")
      .toWeb();

    expect(web.headers.get("Content-Disposition")).toContain('filename=".._.._etc_passwd"');
  });

  it("serves a Blob/File with its own type", async () => {
    const file = new File(["abc"], "hello.bin", { type: "image/png" });
    const web = await HttpResponse.file(file).toWeb();
    expect(web.headers.get("Content-Type")).toBe("image/png");
    expect(await web.text()).toBe("abc");
  });

  it("deleteAfterSend() unlinks the backing file after toWeb()", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resp-"));
    const path = join(dir, "scratch.csv");
    await writeFile(path, "a,b,c");

    const web = await HttpResponse.file(path).deleteAfterSend().toWeb();
    expect(await web.text()).toBe("a,b,c");

    // Fire-and-forget unlink; give the microtask/IO a tick to complete.
    await new Promise((r) => setTimeout(r, 20));
    expect(await fileExists(path)).toBe(false);
  });

  it("streams a Node Readable through without buffering", async () => {
    const { Readable } = await import("node:stream");
    const web = await HttpResponse.file(
      Readable.from([Buffer.from("ab"), Buffer.from("cd"), Buffer.from("ef")]),
    )
      .contentType("text/plain")
      .toWeb();
    expect(web.headers.get("Content-Type")).toBe("text/plain");
    // No Content-Length for a stream. Length is unknown up front.
    expect(web.headers.get("Content-Length")).toBeNull();
    expect(await web.text()).toBe("abcdef");
  });

  it("streams a web ReadableStream through", async () => {
    const body = new Response("web-stream-body").body!;
    const web = await HttpResponse.file(body).toWeb();
    expect(await web.text()).toBe("web-stream-body");
  });
});

describe("toWebResponse boundary", () => {
  it("converts a framework Response and passes a global Response through", async () => {
    const framework = await toWebResponse(HttpResponse.json({ a: 1 }));
    expect(framework).toBeInstanceOf(Response);
    expect(await framework.json()).toEqual({ a: 1 });

    const global = Response.json({ b: 2 });
    expect(await toWebResponse(global)).toBe(global);
  });
});

describe("integration with Router + middleware", () => {
  it("handlers returning a framework Response reach Hono as a real Response", async () => {
    const hono = new Hono();
    const router = new Router(hono);
    router.get("/thing", () => HttpResponse.json({ ok: true }, 201));

    const res = await hono.request("/thing");
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("middleware can mutate headers on a framework Response during egress", async () => {
    const hono = new Hono();
    const router = new Router(hono);

    const tag: HttpPipe = async (request, next) => {
      const res = await next(request);
      res.headers.set("X-Tag", "on");

      return res;
    };

    router.get("/tagged", () => HttpResponse.json({ ok: true })).middleware(tag);

    const res = await hono.request("/tagged");
    expect(res.headers.get("X-Tag")).toBe("on");
    expect(await res.json()).toEqual({ ok: true });
  });
});
