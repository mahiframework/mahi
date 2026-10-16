import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Model } from "@mahiframework/database";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { rule, ValidationException } from "@mahiframework/validation";
import { HttpError } from "../src/http-error.js";
import { Request, requestFromContext } from "../src/request.js";
import { toHonoMiddleware } from "../src/middleware/pipeline-middleware.js";

interface PostAttributes {
  id: string;
  body: string;
}

class Post extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
  timestamps: false,
}) {}

describe("Request.create()", () => {
  it("exposes method, input, only, merge, boolean, and keeps files out of input", () => {
    const file = new File(["hi"], "a.png", { type: "image/png" });
    const request = Request.create(
      "/posts",
      "POST",
      { body: "hello", published: "1" },
      {
        query: { page: "2" },
        files: { image: file },
        ip: "1.2.3.4",
      },
    );

    expect(request.method()).toBe("POST");
    expect(request.isMethod("post")).toBe(true);
    expect(request.path()).toBe("/posts");
    expect(request.input("body")).toBe("hello");
    expect(request.input("page")).toBe("2");
    expect(request.only("body")).toEqual({ body: "hello" });
    expect(request.boolean("published")).toBe(true);
    expect(request.hasFile("image")).toBe(true);
    expect(request.file("image")).toBe(file);
    expect(request.input("image")).toBeUndefined();
    expect(request.ip()).toBe("1.2.3.4");

    request.merge({ extra: true });
    expect(request.input("extra")).toBe(true);
  });

  it("ignores x-forwarded-for, ip() is the socket peer unless trustProxies() says otherwise", () => {
    const request = Request.create(
      "/posts",
      "GET",
      {},
      {
        ip: "203.0.113.9",
        headers: { "x-forwarded-for": "1.2.3.4" },
      },
    );

    // The header is present and is NOT what ip() returns. That is the
    // whole point: it's client-supplied, so honouring it by default let
    // an attacker pick their own rate-limit bucket.
    expect(request.ip()).toBe("203.0.113.9");
    expect(request.peerAddress()).toBe("203.0.113.9");
    // ips() still exposes the unvalidated chain for diagnostics, closest
    // hop last.
    expect(request.ips()).toEqual(["1.2.3.4", "203.0.113.9"]);
  });

  it("integer() coerces query-like values", () => {
    const request = Request.create("/posts", "GET", {}, { query: { per_page: "20" } });
    expect(request.integer("per_page")).toBe(20);
  });
});

describe("Request.from()", () => {
  it("parses a JSON body, query, and route params into the merged input bag", async () => {
    const hono = new Hono();
    hono.post("/posts/:id", async (c) => {
      const request = await Request.from(c);

      return Response.json({
        method: request.method(),
        id: request.route("id"),
        q: request.query("q"),
        body: request.input("body"),
        all: request.all(),
      });
    });

    const res = await hono.request("/posts/abc?q=search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "hello" }),
    });

    expect(await res.json()).toEqual({
      method: "POST",
      id: "abc",
      q: "search",
      body: "hello",
      all: { id: "abc", q: "search", body: "hello" },
    });
  });

  it("parses multipart into input + files", async () => {
    const hono = new Hono();
    hono.post("/upload", async (c) => {
      const request = await Request.from(c);

      return Response.json({
        body: request.input("body"),
        hasFile: request.hasFile("image"),
        fileName: request.file("image")?.name,
      });
    });

    const form = new FormData();
    form.set("body", "hello");
    form.set("image", new File(["abc"], "photo.png", { type: "image/png" }));

    const res = await hono.request("/upload", { method: "POST", body: form });
    expect(await res.json()).toEqual({ body: "hello", hasFile: true, fileName: "photo.png" });
  });

  it("picks up route params after Request was constructed in earlier middleware", async () => {
    const hono = new Hono();
    hono.use("*", toHonoMiddleware([]));
    hono.get("/items/:id", async (c) => {
      const request = await requestFromContext(c);

      return Response.json({ id: request.parameter("id"), all: request.all() });
    });

    const res = await hono.request("/items/abc");
    expect(await res.json()).toEqual({ id: "abc", all: { id: "abc" } });
  });

  it("treats empty GET as an empty input bag", async () => {
    const hono = new Hono();
    hono.get("/ping", async (c) => {
      const request = await Request.from(c);

      return Response.json(request.all());
    });

    const res = await hono.request("/ping");
    expect(await res.json()).toEqual({});
  });

  it("does not throw on empty/invalid JSON, validation decides", async () => {
    const hono = new Hono();
    hono.post("/x", async (c) => {
      const request = await Request.from(c);

      return Response.json(request.all());
    });

    const res = await hono.request("/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(await res.json()).toEqual({});
  });
});

describe("Request validation", () => {
  it("validate() returns false and stashes errors; validateOrFail() throws", async () => {
    const { rule, numberRule, ValidationException } = await import("@mahiframework/validation");

    class CreateUserRequest extends Request {
      rules() {
        return {
          name: rule().string().required(),
          age: numberRule().integer().optional(),
        } as const;
      }
    }

    const failing = new CreateUserRequest({});
    expect(await failing.validate()).toBe(false);
    expect(failing.errors().name).toBeTruthy();
    expect(() => failing.validated()).toThrow(/before a successful validate/);
    await expect(new CreateUserRequest({}).validateOrFail()).rejects.toBeInstanceOf(
      ValidationException,
    );

    const ok = new CreateUserRequest({ name: "Ada" });
    expect(await ok.validate()).toBe(true);
    expect(ok.validated().name).toBe("Ada");
    expect(ok.validated().age).toBeUndefined();
  });
});

describe("Request.passedValidation()", () => {
  /**
   * The two-pass case the hook exists for: `config`'s schema is not known
   * until `driver_key` has been validated, so `rules()` cannot express it.
   */
  class CreateInstanceRequest extends Request {
    seen: unknown;

    rules() {
      return {
        driver_key: rule().string().required().in(["s3", "local"]),
        config: rule().object().optional(),
      } as const;
    }

    override passedValidation(): void {
      const { driver_key: driverKey, config } = this.validated();
      this.seen = config;

      if (
        driverKey === "s3" &&
        (config as Record<string, unknown> | undefined)?.bucket === undefined
      ) {
        throw new ValidationException({ "config.bucket": ["The bucket field is required."] });
      }

      this.mergeValidated({ config: { ...(config ?? {}), driver: driverKey } });
    }
  }

  it("runs after the rules pass, with validated() readable", async () => {
    const request = new CreateInstanceRequest({
      driver_key: "s3",
      config: { bucket: "backups" },
    });

    expect(await request.validate()).toBe(true);
    expect(request.seen).toEqual({ bucket: "backups" });
    expect(request.validated().config).toEqual({ bucket: "backups", driver: "s3" });
  });

  it("does not run when the field rules failed", async () => {
    const request = new CreateInstanceRequest({ driver_key: "ftp" });

    expect(await request.validate()).toBe(false);
    expect(request.seen).toBeUndefined();
    expect(request.errors().driver_key).toBeTruthy();
  });

  it("a ValidationException it throws fails validation and lands in errors()", async () => {
    const request = new CreateInstanceRequest({ driver_key: "s3", config: {} });

    expect(await request.validate()).toBe(false);
    expect(request.errors()["config.bucket"]).toEqual(["The bucket field is required."]);
    expect(() => request.validated()).toThrow(/before a successful validate/);
  });

  it("merges its errors alongside the field errors rather than replacing them", async () => {
    class BothFailRequest extends Request {
      rules() {
        return { name: rule().string().required() } as const;
      }

      override passedValidation(): void {
        throw new ValidationException({ name: ["And it is reserved."] });
      }
    }

    const request = new BothFailRequest({ name: "Ada" });

    expect(await request.validate()).toBe(false);
    expect(request.errors().name).toEqual(["And it is reserved."]);

    const failingField = new BothFailRequest({});
    expect(await failingField.validate()).toBe(false);
    // The field rules failed, so the second pass never ran: the one
    // message here is the rule's, not the hook's.
    expect(failingField.errors().name).toHaveLength(1);
  });

  it("validateOrFail() 422s on a second-pass failure", async () => {
    const request = new CreateInstanceRequest({ driver_key: "s3", config: {} });

    await expect(request.validateOrFail()).rejects.toMatchObject({
      status: 422,
      errors: { "config.bucket": ["The bucket field is required."] },
    });
  });

  it("propagates a non-ValidationException untouched", async () => {
    class ForbiddenRequest extends Request {
      rules() {
        return { name: rule().string().required() } as const;
      }

      override passedValidation(): void {
        throw HttpError.forbidden();
      }
    }

    await expect(new ForbiddenRequest({ name: "Ada" }).validate()).rejects.toMatchObject({
      status: 403,
    });
  });

  it("runs for a request with no rules, where validated() is {}", async () => {
    let ran = false;

    class NoRulesRequest extends Request {
      override passedValidation(): void {
        ran = true;
        expect(this.validated()).toEqual({});
      }
    }

    expect(await new NoRulesRequest({}).validate()).toBe(true);
    expect(ran).toBe(true);
  });

  it("runs once, with validate()", async () => {
    let calls = 0;

    class CountingRequest extends Request {
      rules() {
        return { name: rule().string().required() } as const;
      }

      override passedValidation(): void {
        calls++;
      }
    }

    const request = new CountingRequest({ name: "Ada" });
    expect(await request.validate()).toBe(true);
    expect(await request.validate()).toBe(true);
    await request.validateOrFail();
    expect(calls).toBe(1);
  });

  it("does not recurse when it reaches back through validate()", async () => {
    let calls = 0;

    class ReentrantRequest extends Request {
      rules() {
        return { name: rule().string().required() } as const;
      }

      override async passedValidation(): Promise<void> {
        calls++;
        // The memoized result, not a second pass.
        expect(await this.validate()).toBe(true);
      }
    }

    expect(await new ReentrantRequest({ name: "Ada" }).validate()).toBe(true);
    expect(calls).toBe(1);
  });

  it("mergeValidated() throws before a successful validate()", () => {
    class PlainRequest extends Request {
      rules() {
        return { name: rule().string().required() } as const;
      }
    }

    expect(() => new PlainRequest({ name: "Ada" }).mergeValidated({ name: "Grace" })).toThrow(
      /before a successful validate/,
    );
  });
});

describe("request.model()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("404s when the route param is missing", async () => {
    const request = Request.create("/posts", "GET");
    await expect(request.model(Post)).rejects.toMatchObject({ status: 404 });
  });

  it("404s when the row does not exist", async () => {
    vi.spyOn(Post, "find").mockResolvedValue(undefined);
    const request = Request.create("/posts/missing", "GET", {}, { params: { post: "missing" } });
    await expect(request.model(Post)).rejects.toBeInstanceOf(HttpError);
    await expect(request.model(Post)).rejects.toMatchObject({ status: 404 });
  });

  it("logs a debug line naming the binding when the param is missing", async () => {
    const app = new Application();
    const debug = vi.spyOn(app.logger, "debug");
    setCurrentApp(app);

    try {
      // The classic mis-wiring: a two-word model's default binding name
      // is one lowercase run, while the route param is camelCase.
      class ParsedItem extends Model<PostAttributes>()({
        table: "parsed_items",
        primaryKey: "id",
        timestamps: false,
        morphName: "ParsedItem",
      }) {}

      expect(ParsedItem.routeParamName()).toBe("parseditem");

      const request = Request.create(
        "/parsed-items/abc",
        "GET",
        {},
        { params: { parsedItem: "abc" } },
      );
      await expect(request.model(ParsedItem)).rejects.toMatchObject({ status: 404 });

      expect(debug).toHaveBeenCalledWith(
        "http: route-model binding found no matching route param.",
        expect.objectContaining({
          table: "parsed_items",
          param: "parseditem",
          routeParams: ["parsedItem"],
          path: "/parsed-items/abc",
        }),
      );
    } finally {
      clearCurrentApp(app);
    }
  });

  it("does not log when the param resolved and only the row was missing", async () => {
    const app = new Application();
    const debug = vi.spyOn(app.logger, "debug");
    setCurrentApp(app);

    try {
      vi.spyOn(Post, "find").mockResolvedValue(undefined);
      const request = Request.create("/posts/missing", "GET", {}, { params: { post: "missing" } });
      await expect(request.model(Post)).rejects.toMatchObject({ status: 404 });

      // A missing row is the ordinary 404, not a wiring bug.
      expect(debug).not.toHaveBeenCalled();
    } finally {
      clearCurrentApp(app);
    }
  });

  it("still 404s with no container to log to", async () => {
    clearCurrentApp();
    const request = Request.create("/posts", "GET");
    await expect(request.model(Post)).rejects.toMatchObject({ status: 404 });
  });

  it("returns the row and caches it on the instance", async () => {
    const row = { id: "abc", body: "hello" };
    const find = vi.spyOn(Post, "find").mockResolvedValue(row as never);

    // The param name is derived from the model (Post → "post").
    const request = Request.create("/posts/abc", "GET", {}, { params: { post: "abc" } });
    expect(await request.model(Post)).toEqual(row);
    expect(await request.model(Post)).toEqual(row);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith("abc");
  });

  it("honors an explicit param name override", async () => {
    const row = { id: "abc" };
    vi.spyOn(Post, "find").mockResolvedValue(row as never);
    const request = Request.create("/posts/abc", "GET", {}, { params: { id: "abc" } });
    expect(await request.model(Post, "id")).toEqual(row);
  });
});
