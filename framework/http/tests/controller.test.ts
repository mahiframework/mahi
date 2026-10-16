import { Hono } from "hono";
import { describe, expect, it, expectTypeOf } from "vitest";
import { Request } from "../src/request.js";
import { Controller } from "../src/controller.js";
import { HttpResponse } from "../src/response.js";
import { Router } from "../src/router.js";
import { HttpError } from "../src/http-error.js";
import { rule, numberRule } from "@mahiframework/validation";

class CreateUserRequest extends Request {
  rules() {
    return {
      name: rule().string().required(),
      age: numberRule().integer().min(18).optional(),
    } as const;
  }
}

describe("Controller", () => {
  it("constructs the Request subclass, validates, and types validated()", async () => {
    const hono = new Hono();
    const router = new Router(hono);

    class CreateUserController extends Controller<CreateUserRequest> {
      request = CreateUserRequest;
      async handle(request: CreateUserRequest) {
        const payload = request.validated();
        // `rules()` returns its object `as const`, and `InferRules` is a
        // homomorphic mapped type, so the `readonly` modifier is carried
        // through to the validated payload.
        expectTypeOf(payload).toEqualTypeOf<{
          readonly name: string;
          readonly age: number | undefined;
        }>();

        return HttpResponse.json(payload, 201);
      }
    }

    router.post("/users", CreateUserController);

    const res = await hono.request("/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ada", extra: "ignored" }),
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ name: "Ada" });
  });

  it("supports a bare controller with no Form Request", async () => {
    const hono = new Hono();
    const router = new Router(hono);

    class PingController extends Controller {
      async handle(request: Request) {
        return HttpResponse.json({ path: request.path() });
      }
    }

    router.get("/ping", PingController);

    const res = await hono.request("/ping");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/ping" });
  });

  it("supports inheritance chains (ApiController extends Controller)", async () => {
    const hono = new Hono();
    const router = new Router(hono);

    abstract class ApiController extends Controller {
      protected ok(data: unknown) {
        return HttpResponse.json({ data });
      }
    }

    class ShowController extends ApiController {
      async handle() {
        return this.ok({ id: 1 });
      }
    }

    router.get("/things", ShowController);

    const res = await hono.request("/things");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 1 } });
  });

  it("returns 422 when validation fails, before the handler runs", async () => {
    const { HttpKernel } = await import("../src/http-kernel.js");
    const { Application } = await import("@mahiframework/core");

    class CreateUserController extends Controller<CreateUserRequest> {
      request = CreateUserRequest;
      async handle() {
        return HttpResponse.json({ shouldNotReach: true });
      }
    }

    class Provider {
      routes(router: Router) {
        router.post("/users", CreateUserController);
      }
    }

    const app = new Application();
    (app as any).providers = [new Provider()];
    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();

    const res = await kernel.raw().request("/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: Record<string, string[]> };
    expect(body.errors.name).toBeTruthy();
  });

  it("runs the request's authorize() BEFORE validation; false → 403 even when invalid", async () => {
    const { HttpKernel } = await import("../src/http-kernel.js");
    const { Application } = await import("@mahiframework/core");
    let authorizeRan = false;
    let handleRan = false;

    class DeniedRequest extends CreateUserRequest {
      override authorize() {
        authorizeRan = true;

        return false;
      }
    }

    class CreateUserController extends Controller<DeniedRequest> {
      request = DeniedRequest;
      async handle() {
        handleRan = true;

        return HttpResponse.json({});
      }
    }

    class Provider {
      routes(router: Router) {
        router.post("/users", CreateUserController);
      }
    }

    const app = new Application();
    (app as any).providers = [new Provider()];
    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();

    // A valid payload is denied.
    const denied = await kernel.raw().request("/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ada" }),
    });
    expect(denied.status).toBe(403);
    expect(authorizeRan).toBe(true);
    expect(handleRan).toBe(false);

    // Authorize runs FIRST (Laravel order): an invalid + unauthorized
    // request 403s before validation would 422 it.
    authorizeRan = false;
    const invalid = await kernel.raw().request("/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(invalid.status).toBe(403);
    expect(authorizeRan).toBe(true);
  });

  it("authorize() throwing HttpError.forbidden also 403s", async () => {
    const { HttpKernel } = await import("../src/http-kernel.js");
    const { Application } = await import("@mahiframework/core");

    class ThrowingRequest extends CreateUserRequest {
      override authorize(): boolean {
        throw HttpError.forbidden();
      }
    }

    class CreateUserController extends Controller<ThrowingRequest> {
      request = ThrowingRequest;
      async handle() {
        return HttpResponse.json({});
      }
    }

    class Provider {
      routes(router: Router) {
        router.post("/users", CreateUserController);
      }
    }

    const app = new Application();
    (app as any).providers = [new Provider()];
    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();

    const res = await kernel.raw().request("/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ada" }),
    });
    expect(res.status).toBe(403);
  });

  it("runs prepareForValidation() BEFORE authorize(), so authorize sees prepared input", async () => {
    const { HttpKernel } = await import("../src/http-kernel.js");
    const { Application } = await import("@mahiframework/core");
    const order: string[] = [];

    class PreparedRequest extends Request {
      override prepareForValidation() {
        order.push("prepare");
        // The ordinary case: merge something (a route param, the current
        // user, a tenant id) that authorization then depends on.
        this.merge({ owner: "ada" });
      }

      override authorize(): boolean {
        order.push("authorize");

        return this.input("owner") === "ada";
      }
    }

    class ShowController extends Controller<PreparedRequest> {
      request = PreparedRequest;
      async handle() {
        order.push("handle");

        return HttpResponse.json({ ok: true });
      }
    }

    class Provider {
      routes(router: Router) {
        router.post("/things", ShowController);
      }
    }

    const app = new Application();
    (app as any).providers = [new Provider()];
    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();

    const res = await kernel.raw().request("/things", { method: "POST" });

    // prepareForValidation() must run BEFORE authorize(); otherwise
    // authorize() sees the un-prepared bag and denies a request it
    // should allow.
    expect(res.status).toBe(200);
    expect(order).toEqual(["prepare", "authorize", "handle"]);
  });

  it("runs passedValidation() after the rules and before handle(), 422ing on its failure", async () => {
    const { HttpKernel } = await import("../src/http-kernel.js");
    const { Application } = await import("@mahiframework/core");
    const { ValidationException } = await import("@mahiframework/validation");
    const order: string[] = [];

    class TwoPassRequest extends Request {
      override rules() {
        order.push("rules");

        return {
          driver_key: rule().string().required().in(["s3"]),
          config: rule().object().optional(),
        } as const;
      }

      override passedValidation() {
        order.push("passed");
        const { config } = this.validated();

        if ((config as Record<string, unknown> | undefined)?.bucket === undefined) {
          throw new ValidationException({ "config.bucket": ["The bucket field is required."] });
        }
      }
    }

    class CreateInstanceController extends Controller<TwoPassRequest> {
      request = TwoPassRequest;
      async handle(request: TwoPassRequest) {
        order.push("handle");

        return HttpResponse.json(request.validated(), 201);
      }
    }

    class Provider {
      routes(router: Router) {
        router.post("/instances", CreateInstanceController);
      }
    }

    const app = new Application();
    (app as any).providers = [new Provider()];
    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();
    const post = (body: unknown) =>
      kernel.raw().request("/instances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const bad = await post({ driver_key: "s3", config: {} });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({
      errors: { "config.bucket": ["The bucket field is required."] },
    });
    expect(order).not.toContain("handle");

    order.length = 0;
    const good = await post({ driver_key: "s3", config: { bucket: "backups" } });
    expect(good.status).toBe(201);
    expect(order.indexOf("passed")).toBeLessThan(order.indexOf("handle"));
  });

  it("runs prepareForValidation() exactly once even though validate() also asks for it", async () => {
    let prepares = 0;

    class CountingRequest extends Request {
      override prepareForValidation() {
        prepares++;
      }
      override rules() {
        return { name: rule().string().required() } as const;
      }
    }

    const request = new CountingRequest({ name: "Ada" });
    await request.prepareInput();
    await request.validate();

    expect(prepares).toBe(1);
  });

  it("validated() returns {} for a Request with no rules rather than throwing", () => {
    // Throwing would make the base Request unusable from a controller
    // typed against it: handle() couldn't call validated() without
    // knowing whether the subclass declared rules, and the failure would
    // be a 500 rather than a type error.
    expect(new Request({ a: 1 }).validated()).toEqual({});
  });

  it("still accepts plain function handlers", async () => {
    const hono = new Hono();
    const router = new Router(hono);

    router.get("/up", () => HttpResponse.json({ status: "ok" }));

    const res = await hono.request("/up");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
