import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { AUTH_TOKEN } from "@mahiframework/core";
import { HttpError, HttpResponse, Router } from "@mahiframework/http";
import { MfaManager } from "../../src/mfa-manager.js";
import { MFA_TOKEN } from "../../src/tokens.js";
import { runWithMfa } from "../../src/mfa-context.js";
import { ensureMfa } from "../../src/middleware/ensure-mfa.js";
import type { MfaDriver } from "../../src/mfa-driver.js";
import {
  createTestDatabase,
  makeIntent,
  type TestDatabase,
} from "../__fixtures__/test-database.js";

describe("ensureMfa", () => {
  let database: TestDatabase;

  const driver: MfaDriver = {
    name: "totp",
    enrolled: async () => true,
    challenge: async () => ({ status: "ready" }),
    verify: async () => ({ status: "verified" }),
  };

  /**
   * Mount through the real `Router`, wrapped in the MFA scope the
   * provider's pipe would open.
   *
   * `onError` stands in for `HttpKernel`'s error handler, which is what
   * turns a thrown `HttpError` into a response in a real app. Without
   * it every denial surfaces as a 500 and the status assertions below
   * would be meaningless. `details` is rendered too, since the whole
   * point of these errors is the payload a client branches on.
   */
  function mount(
    purpose?: string | null,
    binding: string | null = null,
    onHandler?: () => void,
  ): Hono {
    const hono = new Hono();

    hono.onError((error) => {
      if (error instanceof HttpError) {
        return Response.json(
          { error: error.message, details: error.details },
          { status: error.status },
        );
      }

      return Response.json({ error: String(error) }, { status: 500 });
    });

    const router = new Router(hono);

    router
      .get("/guarded", () => {
        onHandler?.();

        return HttpResponse.json({ ok: true });
      })
      .middleware(
        (request, next) => runWithMfa({ binding, request }, () => next(request)),
        ensureMfa(purpose),
      );

    return hono;
  }

  function authenticateAs(user: unknown) {
    database.app.instance(AUTH_TOKEN, {
      userOrNull: () => user,
      userProvider: () => ({ retrieveById: async (id: string) => ({ id }) }),
      guard: () => ({}),
      getDefaultDriver: () => "web",
    });
  }

  beforeEach(async () => {
    database = await createTestDatabase();
    authenticateAs({ id: "user-1" });

    const manager = new MfaManager(database.app, { drivers: ["totp"] });
    manager.extend("totp", () => driver);
    database.app.instance(MFA_TOKEN, manager);
  });

  afterEach(() => database.cleanup());

  it("passes the request through when verified", async () => {
    await makeIntent({ userId: "user-1", status: "verified" });

    const response = await mount().request("/guarded");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("403s with a structured payload when not verified", async () => {
    const response = await mount().request("/guarded");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      details: { code: "mfa_required", purpose: null, available: ["totp"] },
    });
  });

  it("does not run the handler when it denies", async () => {
    // The point of a pipe: the guard runs BEFORE the handler, so a
    // denied request cannot have had side effects.
    let ran = false;

    await mount(null, null, () => {
      ran = true;
    }).request("/guarded");

    expect(ran).toBe(false);
  });

  it("enforces a named purpose", async () => {
    await makeIntent({ userId: "user-1", status: "verified", purpose: "other" });

    const response = await mount("change_password").request("/guarded");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      details: { purpose: "change_password" },
    });
  });

  it("accepts a named intent for a generic guard", async () => {
    await makeIntent({ userId: "user-1", status: "verified", purpose: "change_password" });

    expect((await mount().request("/guarded")).status).toBe(200);
  });

  it("401s a guest", async () => {
    authenticateAs(null);

    expect((await mount().request("/guarded")).status).toBe(401);
  });

  it("enforces the session binding", async () => {
    await makeIntent({ userId: "user-1", status: "verified", binding: "session-a" });

    expect((await mount(null, "session-a").request("/guarded")).status).toBe(200);
    expect((await mount(null, "session-b").request("/guarded")).status).toBe(403);
  });
});
