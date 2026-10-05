import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTH_TOKEN } from "@mahiframework/core";
import { HttpError, type HttpPipeFn } from "@mahiframework/http";
import { permission } from "../src/middleware/permission.js";
import { role } from "../src/middleware/role.js";
import { roleOrPermission } from "../src/middleware/role-or-permission.js";
import { createHarness, captureError, makeUser, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

/**
 * The pipes read the current user off `AUTH_TOKEN`, structurally, rather
 * than importing `AuthManager` — so a stub with the one method they call
 * is a faithful stand-in and the test needs no auth config.
 */
function actAs(user: unknown): void {
  harness.app.instance(AUTH_TOKEN, { userOrNull: () => user });
}

/**
 * Run a pipe and report whether it called through.
 *
 * Typed `HttpPipeFn`, not `HttpPipe`: the latter is a union with the
 * object form (`{ handle }`) and so isn't callable. These pipes are
 * functions, and saying so here is what keeps that true.
 */
async function passes(pipe: HttpPipeFn): Promise<boolean> {
  let reached = false;

  await pipe(null as never, () => {
    reached = true;

    return Promise.resolve(null as never);
  });

  return reached;
}

/** Run a pipe expected to reject, and return the thrown error. */
function rejects(pipe: HttpPipeFn): Promise<unknown> {
  return captureError(Promise.resolve(pipe(null as never, () => Promise.resolve(null as never))));
}

beforeEach(async () => {
  harness = await createHarness();
  await harness.registrar.createRole("admin");
  await harness.registrar.createRole("editor");
  await harness.registrar.createPermission("posts.edit");
  await harness.registrar.givePermissionToRole("editor", "posts.edit");
});

afterEach(() => harness.cleanup());

describe("role()", () => {
  it("passes a holder", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole(user, "admin");
    actAs(user);

    expect(await passes(role("admin"))).toBe(true);
  });

  it("403s a non-holder", async () => {
    const user = await makeUser();
    actAs(user);

    const error = await rejects(role("admin"));

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(403);
  });

  it("403s a guest, not 401", async () => {
    // 401 is not an authorization decision; the gate takes the same
    // stance. A route that wants "log in" carries `authenticate()`, which
    // produces the 401 before this pipe ever runs.
    actAs(null);

    expect(((await rejects(role("admin"))) as HttpError).status).toBe(403);
  });

  it("is any-of for a list", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole(user, "editor");
    actAs(user);

    expect(await passes(role(["admin", "editor"]))).toBe(true);
  });

  it("denies when none of the listed roles is held", async () => {
    const user = await makeUser();
    actAs(user);

    expect(((await rejects(role(["admin", "editor"]))) as HttpError).status).toBe(403);
  });

  it("403s a non-model user rather than throwing", async () => {
    // A subject with no morph alias and no bigint key cannot hold a role,
    // so it holds none. Denying beats a 500.
    actAs({ id: "not-a-model" });

    expect(((await rejects(role("admin"))) as HttpError).status).toBe(403);
  });

  it("surfaces a missing auth scope rather than silently authorizing", async () => {
    // If `authenticate()` never ran there is no auth scope at all, and
    // the underlying error must propagate. Treating that as a guest would
    // be an authorization decision made by accident — it happens to deny
    // here, but it would mean the pipe cannot tell "nobody is logged in"
    // from "the route is misconfigured".
    harness.app.instance(AUTH_TOKEN, {
      userOrNull: () => {
        throw new Error("MissingAuthContextError");
      },
    });

    const error = await rejects(role("admin"));

    expect(error).not.toBeInstanceOf(HttpError);
    expect((error as Error).message).toBe("MissingAuthContextError");
  });

  it("403s when auth is not bound at all", async () => {
    expect(((await rejects(role("admin"))) as HttpError).status).toBe(403);
  });

  it("honours a non-default guard", async () => {
    await harness.registrar.createRole("admin", { guard: "api" });
    const user = await makeUser();
    await harness.registrar.assignRole(user, "admin", { guard: "api" });
    actAs(user);

    expect(await passes(role("admin", { guard: "api" }))).toBe(true);
    // The same assignment must not satisfy the web guard.
    expect(((await rejects(role("admin"))) as HttpError).status).toBe(403);
  });
});

describe("permission()", () => {
  it("passes a holder, via a role", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole(user, "editor");
    actAs(user);

    expect(await passes(permission("posts.edit"))).toBe(true);
  });

  it("passes a holder, directly granted", async () => {
    const user = await makeUser();
    await harness.registrar.givePermissionTo(user, "posts.edit");
    actAs(user);

    expect(await passes(permission("posts.edit"))).toBe(true);
  });

  it("403s a non-holder", async () => {
    const user = await makeUser();
    actAs(user);

    expect(((await rejects(permission("posts.edit"))) as HttpError).status).toBe(403);
  });

  it("403s an unknown permission name rather than 500ing", async () => {
    const user = await makeUser();
    actAs(user);

    expect(((await rejects(permission("no.such.thing"))) as HttpError).status).toBe(403);
  });
});

describe("roleOrPermission()", () => {
  it("passes on the role alone", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole(user, "admin");
    actAs(user);

    expect(await passes(roleOrPermission({ roles: ["admin"], permissions: ["posts.edit"] }))).toBe(
      true,
    );
  });

  it("passes on the permission alone", async () => {
    const user = await makeUser();
    await harness.registrar.givePermissionTo(user, "posts.edit");
    actAs(user);

    expect(await passes(roleOrPermission({ roles: ["admin"], permissions: ["posts.edit"] }))).toBe(
      true,
    );
  });

  it("denies when neither is held", async () => {
    // This is the OR that stacking `role()` and `permission()` cannot
    // express: stacked, they are an AND.
    const user = await makeUser();
    actAs(user);

    const error = await rejects(
      roleOrPermission({ roles: ["admin"], permissions: ["posts.edit"] }),
    );

    expect((error as HttpError).status).toBe(403);
  });

  it("denies when both lists are empty", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole(user, "admin");
    actAs(user);

    // Nothing was asked for, so nothing is satisfied. Failing closed
    // beats letting an empty config open a route.
    expect(((await rejects(roleOrPermission({}))) as HttpError).status).toBe(403);
  });
});
