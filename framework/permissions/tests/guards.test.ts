import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, makeUser, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

/**
 * Guard isolation is the point of `guard_name` existing. An app with an
 * `api` guard and a `web` guard has two populations of users, and an
 * `api` role satisfying a `web` check would be a privilege escalation
 * across that boundary.
 *
 * Note the assignment rows carry no guard: a subject simply holds role
 * id N, and the filtering happens when the role is resolved through the
 * map. That is deliberate (a role already knows its own guard, so
 * storing it again on the pivot would be a second source of truth) and
 * it is what these tests pin.
 */
beforeEach(async () => {
  harness = await createHarness();

  await harness.registrar.createRole("admin", { guard: "web" });
  await harness.registrar.createRole("admin", { guard: "api" });
  await harness.registrar.createPermission("posts.edit", { guard: "web" });
  await harness.registrar.createPermission("posts.edit", { guard: "api" });

  await harness.registrar.givePermissionToRole("admin", "posts.edit", { guard: "web" });
});

afterEach(() => harness.cleanup());

describe("guard isolation", () => {
  it("does not let an api role satisfy a web check", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole(user, "admin", { guard: "api" });

    expect(await harness.registrar.hasRole(user, "admin", { guard: "api" })).toBe(true);
    expect(await harness.registrar.hasRole(user, "admin", { guard: "web" })).toBe(false);
  });

  it("does not let an api role's permissions satisfy a web permission check", async () => {
    const user = await makeUser();
    await harness.registrar.givePermissionToRole("admin", "posts.edit", { guard: "api" });
    await harness.registrar.assignRole(user, "admin", { guard: "api" });

    expect(await harness.registrar.hasPermissionTo(user, "posts.edit", { guard: "api" })).toBe(
      true,
    );
    expect(await harness.registrar.hasPermissionTo(user, "posts.edit", { guard: "web" })).toBe(
      false,
    );
  });

  it("does not grant a web permission through an api role, even on the same name", async () => {
    // The sharpest case: the names line up on both sides, and only the
    // guard distinguishes them. A missing guard predicate anywhere in the
    // resolution chain shows up here and nowhere else.
    const user = await makeUser();
    await harness.registrar.assignRole(user, "admin", { guard: "api" });

    expect(await harness.registrar.getPermissionsViaRoles(user, { guard: "web" })).toEqual(
      new Set(),
    );
  });

  it("keeps direct permissions guard-scoped too", async () => {
    const user = await makeUser();
    await harness.registrar.givePermissionTo(user, "posts.edit", { guard: "api" });

    expect(await harness.registrar.hasDirectPermission(user, "posts.edit", { guard: "api" })).toBe(
      true,
    );
    expect(await harness.registrar.hasDirectPermission(user, "posts.edit", { guard: "web" })).toBe(
      false,
    );
  });

  it("falls back to the configured guard when none is named", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole(user, "admin");

    // Config says "web", so the unqualified check and the explicit web
    // check must agree.
    expect(await harness.registrar.hasRole(user, "admin")).toBe(true);
    expect(await harness.registrar.hasRole(user, "admin", { guard: "web" })).toBe(true);
  });

  it("reports only the resolved guard's roles", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole(user, "admin", { guard: "web" });
    await harness.registrar.assignRole(user, "admin", { guard: "api" });

    // Two assignment rows, two distinct roles, but each guard sees one.
    expect([...(await harness.registrar.getRoleNames(user, { guard: "web" }))]).toEqual(["admin"]);
    expect([...(await harness.registrar.getRoleNames(user, { guard: "api" }))]).toEqual(["admin"]);
  });
});
