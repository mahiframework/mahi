import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GateRegistry, Policy } from "@mahiframework/authorization";
import { createHarness, makeUser, Team, User, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;
let gate: GateRegistry;

/** A policy that always grants, so "the policy still ran" is unambiguous. */
class UserPolicy extends Policy<unknown, unknown> {
  update(): boolean {
    return true;
  }
}

beforeEach(async () => {
  harness = await createHarness();
  gate = new GateRegistry(harness.app);
  harness.provider.gates(gate);

  await harness.registrar.createRole("editor");
  await harness.registrar.createPermission("posts.edit");
  await harness.registrar.givePermissionToRole("editor", "posts.edit");
});

afterEach(() => harness.cleanup());

describe("the gate hook", () => {
  it("grants a bare ability matching a held permission", async () => {
    // The headline integration: `can("posts.edit")` consults permissions
    // without the gate, the middleware, or the caller knowing this
    // package exists.
    const user = await makeUser();
    await harness.registrar.assignRole(user, "editor");

    expect(await gate.forUser(user).allows("posts.edit")).toBe(true);
  });

  it("abstains rather than denying when the permission is not held", async () => {
    // THE most important assertion in this package. A `before()` hook
    // returning `false` hard-denies and skips policy resolution
    // ENTIRELY, so denying on a permission miss would make every policy
    // in the app unreachable. Abstaining leaves the pipeline intact, and
    // the default deny at the end of it still yields false here.
    const user = await makeUser();

    expect(await gate.forUser(user).allows("posts.edit")).toBe(false);
  });

  it("leaves a policy able to grant after a permission miss", async () => {
    // The consequence of the above, stated directly: if the hook ever
    // returns `false` instead of `null`, this test is what fails.
    gate.policy(User as never, UserPolicy);
    const user = await makeUser();

    expect(await gate.forUser(user).allows("update", User, user)).toBe(true);
  });

  it("leaves a defined ability able to grant after a permission miss", async () => {
    gate.define("ring-the-bell", () => true);
    const user = await makeUser();

    expect(await gate.forUser(user).allows("ring-the-bell")).toBe(true);
  });

  it("abstains when the check carries a model argument", async () => {
    // A DELIBERATE divergence from spatie. There,
    // `Gate::allows("update", $post)` also consults permissions, so an app
    // with both a permission named "update" and a PostPolicy.update
    // grants update on EVERY post to anyone holding that permission.
    await harness.registrar.createPermission("update");
    await harness.registrar.givePermissionToRole("editor", "update");
    const user = await makeUser();
    await harness.registrar.assignRole(user, "editor");

    // Holds the permission named "update"...
    expect(await harness.registrar.hasPermissionTo(user, "update")).toBe(true);
    // ...but a model-scoped check is the policy's business, and no policy
    // is registered, so it fails closed instead of granting on every row.
    expect(await gate.forUser(user).allows("update", Team)).toBe(false);
  });

  it("abstains for a guest", async () => {
    expect(await gate.forUser(null).allows("posts.edit")).toBe(false);
  });

  it("abstains for a non-model user instead of throwing", async () => {
    // A token-guard adapter or a plain object has no morph alias and no
    // bigint key, so `resolveAssignee()` would throw — and a hook that
    // throws turns every authorization check in the app into a 500.
    const allows = await gate.forUser({ id: "not-a-model" }).allows("posts.edit");

    expect(allows).toBe(false);
  });

  it("honours a direct permission, not just role-derived ones", async () => {
    const user = await makeUser();
    await harness.registrar.givePermissionTo(user, "posts.edit");

    expect(await gate.forUser(user).allows("posts.edit")).toBe(true);
  });

  it("registers nothing when the gate integration is disabled", async () => {
    const off = await createHarness({ gate: false });

    try {
      const offGate = new GateRegistry(off.app);
      off.provider.gates(offGate);

      await off.registrar.createRole("editor");
      await off.registrar.createPermission("posts.edit");
      await off.registrar.givePermissionToRole("editor", "posts.edit");
      const user = await makeUser();
      await off.registrar.assignRole(user, "editor");

      expect(await offGate.forUser(user).allows("posts.edit")).toBe(false);
    } finally {
      off.cleanup();
    }
  });

  it("does not throw for an ability that is not a permission name", async () => {
    // The hook sees every ability string in the app, almost none of which
    // are permissions.
    const user = await makeUser();

    expect(await gate.forUser(user).allows("some-unrelated-ability")).toBe(false);
  });
});
