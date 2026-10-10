import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DB } from "@mahiframework/database";
import { UnsupportedAssigneeKeyError } from "../src/errors.js";
import { resolveAssignee } from "../src/assignee.js";
import {
  createHarness,
  captureError,
  makeLegacyAccount,
  makeTeam,
  makeUser,
  LegacyAccount,
  type Harness,
} from "./__fixtures__/test-app.js";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
  await harness.registrar.createRole("admin");
  await harness.registrar.createRole("editor");
  await harness.registrar.createPermission("posts.edit");
  await harness.registrar.createPermission("posts.delete");
  await harness.registrar.createPermission("billing.view");
  await harness.registrar.givePermissionToRole("editor", "posts.edit");
  await harness.registrar.givePermissionToRole("admin", ["posts.edit", "posts.delete"]);
});

afterEach(() => harness.cleanup());

describe("subject roles", () => {
  it("assigns a role and reports it", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole(user, "admin");

    expect(await harness.registrar.hasRole(user, "admin")).toBe(true);
    expect([...(await harness.registrar.getRoleNames(user))]).toEqual(["admin"]);
  });

  it("is idempotent, so re-assigning does not violate the composite primary key", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole(user, "admin");
    await harness.registrar.assignRole(user, ["admin", "editor"]);

    expect(await DB.table("model_has_roles").count()).toBe(2);
  });

  it("removes a role", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole(user, ["admin", "editor"]);
    await harness.registrar.removeRole(user, "admin");

    expect(await harness.registrar.hasRole(user, "admin")).toBe(false);
    expect(await harness.registrar.hasRole(user, "editor")).toBe(true);
  });

  it("syncs to exactly the given roles", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole(user, "admin");
    await harness.registrar.syncRoles(user, "editor");

    expect([...(await harness.registrar.getRoleNames(user))]).toEqual(["editor"]);
  });

  it("syncs an empty array to no roles at all", async () => {
    // The one behaviour everyone gets wrong, and the reason this package
    // writes pivots directly: the framework's `detach([])` is a
    // deliberate no-op, so routing `syncRoles(user, request.input("roles"))`
    // through that API would silently keep every role when the input is
    // an empty list.
    const user = await makeUser();
    await harness.registrar.assignRole(user, ["admin", "editor"]);
    await harness.registrar.syncRoles(user, []);

    expect(await harness.registrar.getRoleNames(user)).toEqual(new Set());
    expect(await DB.table("model_has_roles").count()).toBe(0);
  });

  it("hasAnyRole and hasAllRoles differ", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole(user, "admin");

    expect(await harness.registrar.hasAnyRole(user, ["admin", "editor"])).toBe(true);
    expect(await harness.registrar.hasAllRoles(user, ["admin", "editor"])).toBe(false);
    expect(await harness.registrar.hasAllRoles(user, ["admin"])).toBe(true);
  });

  it("does not leak roles between two models sharing a numeric id", async () => {
    // `model_has_roles` discriminates on `model_type`, and the composite
    // primary key puts `model_type` last — so a missing predicate
    // anywhere would show up as a Team inheriting a User's roles.
    const user = await makeUser();
    const team = await makeTeam();
    await DB.table("teams").where("id", team.id).update({ id: user.id });
    await harness.registrar.assignRole(user, "admin");

    const sharedTeam = { type: "Team", id: user.id };

    expect(await harness.registrar.hasRole(sharedTeam, "admin")).toBe(false);
  });

  it("cascades a subject's assignments when the role is deleted", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole(user, "admin");
    await harness.registrar.deleteRole("admin");

    expect(await DB.table("model_has_roles").count()).toBe(0);
  });
});

describe("inherited permissions", () => {
  it("inherits every permission its roles grant", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole(user, "admin");

    expect(await harness.registrar.hasPermissionTo(user, "posts.edit")).toBe(true);
    expect(await harness.registrar.hasPermissionTo(user, "posts.delete")).toBe(true);
    expect(await harness.registrar.hasPermissionTo(user, "billing.view")).toBe(false);
  });

  it("loses them when the role is removed", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole(user, "admin");
    await harness.registrar.removeRole(user, "admin");

    expect(await harness.registrar.hasPermissionTo(user, "posts.edit")).toBe(false);
  });

  it("gains them when the role gains a permission, with no per-user write", async () => {
    // The whole point of the indirection: one write changes what every
    // holder may do.
    const user = await makeUser();
    await harness.registrar.assignRole(user, "editor");

    expect(await harness.registrar.hasPermissionTo(user, "billing.view")).toBe(false);

    await harness.registrar.givePermissionToRole("editor", "billing.view");

    expect(await harness.registrar.hasPermissionTo(user, "billing.view")).toBe(true);
  });

  it("returns false for an unknown permission name rather than throwing", async () => {
    // The gate hook calls this with every ability string in the app,
    // almost none of which are permissions, so throwing would turn
    // `can("view-dashboard")` into a 500.
    const user = await makeUser();

    expect(await harness.registrar.hasPermissionTo(user, "no.such.permission")).toBe(false);
  });
});

describe("direct permissions", () => {
  it("supplements roles", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole(user, "editor");
    await harness.registrar.givePermissionTo(user, "billing.view");

    expect([...(await harness.registrar.getAllPermissions(user))].sort()).toEqual([
      "billing.view",
      "posts.edit",
    ]);
  });

  it("works with no roles at all", async () => {
    const user = await makeUser();
    await harness.registrar.givePermissionTo(user, "billing.view");

    expect(await harness.registrar.hasPermissionTo(user, "billing.view")).toBe(true);
    expect(await harness.registrar.getRoleNames(user)).toEqual(new Set());
  });

  it("is distinguishable from an inherited permission", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole(user, "editor");
    await harness.registrar.givePermissionTo(user, "billing.view");

    expect(await harness.registrar.hasDirectPermission(user, "billing.view")).toBe(true);
    // Held, but via the role, so not direct.
    expect(await harness.registrar.hasPermissionTo(user, "posts.edit")).toBe(true);
    expect(await harness.registrar.hasDirectPermission(user, "posts.edit")).toBe(false);
  });

  it("revoking a direct grant leaves a role-granted one standing", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole(user, "editor");
    await harness.registrar.givePermissionTo(user, "posts.edit");
    await harness.registrar.revokePermissionTo(user, "posts.edit");

    expect(await harness.registrar.hasDirectPermission(user, "posts.edit")).toBe(false);
    expect(await harness.registrar.hasPermissionTo(user, "posts.edit")).toBe(true);
  });

  it("syncs direct permissions without touching roles", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole(user, "editor");
    await harness.registrar.givePermissionTo(user, "billing.view");
    await harness.registrar.syncPermissions(user, []);

    expect(await harness.registrar.getDirectPermissions(user)).toEqual(new Set());
    expect([...(await harness.registrar.getRoleNames(user))]).toEqual(["editor"]);
  });

  it("is idempotent", async () => {
    const user = await makeUser();
    await harness.registrar.givePermissionTo(user, "billing.view");
    await harness.registrar.givePermissionTo(user, ["billing.view", "posts.edit"]);

    expect(await DB.table("model_has_permissions").count()).toBe(2);
  });
});

describe("assignee resolution", () => {
  it("rejects a string-keyed model with a clear error instead of emitting SQL", async () => {
    // `model_id` is a bigInteger. Postgres would raise `operator does not
    // exist` (a 500 naming no model) and SQLite would store the string
    // and never match it — a check that silently returns false forever.
    const account = await LegacyAccount.create({ id: "acct_1", name: "Legacy" });

    const error = await captureError(harness.registrar.assignRole(account, "admin"));

    expect(error).toBeInstanceOf(UnsupportedAssigneeKeyError);
  });

  it("accepts an explicit descriptor, for a job with no model in hand", async () => {
    const user = await makeUser();
    await harness.registrar.assignRole({ type: "User", id: user.id }, "admin");

    expect(await harness.registrar.hasRole(user, "admin")).toBe(true);
  });

  it("reads the morph alias off the model class", async () => {
    const user = await makeUser();

    expect(resolveAssignee(user)).toEqual({ morphType: "User", key: user.id });
  });

  it("names the configured key type in the error", async () => {
    const account = await LegacyAccount.create({ id: "acct_2", name: "Legacy" });
    const error = await captureError(harness.registrar.assignRole(account, "admin"));

    expect(String(error)).toContain('permissions.assigneeKey is "bigint"');
  });

  it("reports the configured key type", () => {
    expect(harness.registrar.assigneeKeyType()).toBe("bigint");
  });
});

describe('assigneeKey: "uuid"', () => {
  // `keyType: "uuidv7"` is what `docs/models` recommends and
  // `make:model --uuidv7` scaffolds, so an app that took that advice has
  // to be able to install this package at all.
  let uuid: Harness;

  beforeEach(async () => {
    uuid = await createHarness({ assigneeKey: "uuid" });
    await uuid.registrar.createRole("admin");
    await uuid.registrar.createPermission("posts.edit");
    await uuid.registrar.givePermissionToRole("admin", "posts.edit");
  });

  afterEach(() => uuid.cleanup());

  it("assigns a role to a uuid-keyed subject", async () => {
    const account = await makeLegacyAccount();

    await uuid.registrar.assignRole(account, "admin");

    expect(await uuid.registrar.hasRole(account, "admin")).toBe(true);
  });

  it("grants that role's permissions", async () => {
    const account = await makeLegacyAccount();

    await uuid.registrar.assignRole(account, "admin");

    expect(await uuid.registrar.hasPermissionTo(account, "posts.edit")).toBe(true);
  });

  it("grants a direct permission", async () => {
    const account = await makeLegacyAccount();

    await uuid.registrar.givePermissionTo(account, "posts.edit");

    expect(await uuid.registrar.hasDirectPermission(account, "posts.edit")).toBe(true);
  });

  it("stores the key as a string, so the pivot read matches it back", async () => {
    const account = await makeLegacyAccount();

    await uuid.registrar.assignRole(account, "admin");

    const rows = await DB.table<{ model_id: unknown }>("model_has_roles").select("model_id").get();

    expect(typeof rows[0]?.model_id).toBe("string");
    expect(rows[0]?.model_id).toBe(account.id);
  });

  it("eager-loads through the relation, which binds the local key raw", async () => {
    // The whole reason the column is typed rather than text: a mismatch
    // breaks `with("roles")` and `whereHas("roles", ...)` entirely.
    const account = await makeLegacyAccount();

    await uuid.registrar.assignRole(account, "admin");

    const loaded = await LegacyAccount.query().with("roles").whereKey(account.id).first();

    expect([...(loaded?.roles ?? [])].map((role) => role.name)).toEqual(["admin"]);
  });

  it("does not leak one subject's roles to another with a similar key", async () => {
    const [one, two] = [await makeLegacyAccount(), await makeLegacyAccount()];

    await uuid.registrar.assignRole(one, "admin");

    expect(await uuid.registrar.hasRole(two, "admin")).toBe(false);
  });

  it("syncs and removes", async () => {
    const account = await makeLegacyAccount();

    await uuid.registrar.assignRole(account, "admin");
    await uuid.registrar.syncRoles(account, []);

    expect(await uuid.registrar.hasRole(account, "admin")).toBe(false);
  });

  it("rejects a bigint-keyed model, which is now the wrong shape", async () => {
    // The guard moves with the column rather than being dropped: an
    // integer key against a uuid column is the same class of defect in
    // the other direction.
    const user = await makeUser();
    const error = await captureError(uuid.registrar.assignRole(user, "admin"));

    expect(error).toBeInstanceOf(UnsupportedAssigneeKeyError);
    expect(String(error)).toContain('permissions.assigneeKey is "uuid"');
  });

  it("rejects an empty string, which is not a key", async () => {
    const error = await captureError(
      uuid.registrar.assignRole({ type: "LegacyAccount", id: "" }, "admin"),
    );

    expect(error).toBeInstanceOf(UnsupportedAssigneeKeyError);
  });

  it("accepts an explicit descriptor", async () => {
    const account = await makeLegacyAccount();

    await uuid.registrar.assignRole({ type: "LegacyAccount", id: account.id }, "admin");

    expect(await uuid.registrar.hasRole(account, "admin")).toBe(true);
  });

  it("reports the configured key type", () => {
    expect(uuid.registrar.assigneeKeyType()).toBe("uuid");
  });

  it("keeps role_id a bigint, since it references this package's own table", async () => {
    const account = await makeLegacyAccount();

    await uuid.registrar.assignRole(account, "admin");

    const rows = await DB.table<{ role_id: unknown }>("model_has_roles").select("role_id").get();

    expect(typeof rows[0]?.role_id).not.toBe("string");
  });
});
