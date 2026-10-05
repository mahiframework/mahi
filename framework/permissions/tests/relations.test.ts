import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, makeUser, User, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

/**
 * The relation helpers are the entire justification for `model_id` being
 * a `bigInteger` rather than text (which is what every other polymorphic
 * table in this framework uses). `buildPivotQuery()` binds the local key
 * RAW, so a bigint-keyed model against a varchar column makes Postgres
 * raise `operator does not exist` — text would have broken exactly these
 * reads. If these tests ever go, so does the reason for that column type.
 */
beforeEach(async () => {
  harness = await createHarness();
  await harness.registrar.createRole("admin");
  await harness.registrar.createRole("editor");
  await harness.registrar.createPermission("posts.edit");
  await harness.registrar.createPermission("billing.view");
  await harness.registrar.givePermissionToRole("editor", "posts.edit");
});

afterEach(() => harness.cleanup());

describe("rolesRelation()", () => {
  it("eager-loads a subject's roles", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole(user, ["admin", "editor"]);

    const loaded = await User.query().whereKey(user.id).with("roles").first();

    expect(
      loaded!.roles
        ?.all()
        .map((r) => r.name)
        .sort(),
    ).toEqual(["admin", "editor"]);
  });

  it("nests through to each role's permissions", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole(user, "editor");

    const loaded = await User.query().whereKey(user.id).with("roles.permissions").first();
    const role = loaded!.roles?.first();

    expect(role?.permissions?.all().map((p) => p.name)).toEqual(["posts.edit"]);
  });

  it("filters by a role's attributes with whereHas", async () => {
    const admin = await makeUser();
    const nobody = await makeUser();
    await harness.registrar.assignRole(admin, "admin");

    const found = await User.query()
      .whereHas("roles", (query) => query.where("name", "admin"))
      .get();

    expect(found.all().map((u) => u.id)).toEqual([admin.id]);
    expect(found.all().map((u) => u.id)).not.toContain(nobody.id);
  });

  it("yields an empty collection for a subject with no roles", async () => {
    const user = await makeUser();

    const loaded = await User.query().whereKey(user.id).with("roles").first();

    expect(loaded!.roles?.all()).toEqual([]);
  });

  it("queries lazily off an instance", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole(user, "admin");

    const roles = await user.relations.roles().get();

    expect(roles.all().map((r) => r.name)).toEqual(["admin"]);
  });

  it("discriminates on model_type, so another model's rows are not visible", async () => {
    // `type` is omitted in the helper so it defaults to the DECLARING
    // model's morphAlias(), which is what morphToMany wants. A wrong
    // default would show up as cross-model leakage here.
    const user = await makeUser();
    await harness.registrar.assignRole(user, "admin");
    await harness.registrar.assignRole({ type: "Team", id: user.id }, "editor");

    const loaded = await User.query().whereKey(user.id).with("roles").first();

    expect(loaded!.roles?.all().map((r) => r.name)).toEqual(["admin"]);
  });
});

describe("permissionsRelation()", () => {
  it("eager-loads direct permissions only", async () => {
    // Role-inherited permissions are two hops through a polymorphic
    // pivot, which the ORM cannot express as one relation.
    // `getAllPermissions()` is the union.
    const user = await makeUser();
    await harness.registrar.assignRole(user, "editor");
    await harness.registrar.givePermissionTo(user, "billing.view");

    const loaded = await User.query().whereKey(user.id).with("permissions").first();

    expect(loaded!.permissions?.all().map((p) => p.name)).toEqual(["billing.view"]);
  });
});
