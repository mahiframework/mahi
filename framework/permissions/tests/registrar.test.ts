import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DB } from "@mahiframework/database";
import { Role } from "../src/models/role.model.js";
import { Permission } from "../src/models/permission.model.js";
import {
  DuplicateNameError,
  PermissionNotFoundError,
  RoleNotFoundError,
  UnresolvedGuardError,
} from "../src/errors.js";
import { createHarness, captureError, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(() => harness.cleanup());

describe("roles and permissions", () => {
  it("creates a role under the configured guard", async () => {
    const role = await harness.registrar.createRole("admin");

    expect(role.name).toBe("admin");
    expect(role.guard_name).toBe("web");
    // A snowflake-shaped key, not an auto-increment one: the column is a
    // bigInteger primary key and the model assigns the id itself.
    expect(typeof role.id).toBe("bigint");
  });

  it("refuses a duplicate name within one guard", async () => {
    await harness.registrar.createRole("admin");

    const error = await captureError(harness.registrar.createRole("admin"));

    expect(error).toBeInstanceOf(DuplicateNameError);
  });

  it("allows the same name under a different guard", async () => {
    await harness.registrar.createRole("admin");
    const api = await harness.registrar.createRole("admin", { guard: "api" });

    expect(api.guard_name).toBe("api");
  });

  it("enforces (name, guard_name) uniqueness in the database, not just in the service", async () => {
    // The service checks the cached map first, so without this the
    // constraint could be missing from the migration and every test
    // would still pass — until two concurrent requests raced.
    await harness.registrar.createRole("admin");

    const error = await captureError(Role.create({ id: 1n, name: "admin", guard_name: "web" }));

    expect(error).toBeInstanceOf(Error);
  });

  it("finds a role by name", async () => {
    const created = await harness.registrar.createRole("admin");

    expect((await harness.registrar.findRole("admin")).id).toBe(created.id);
  });

  it("throws on an unknown role name rather than returning null", async () => {
    // Writes throw on a typo because the alternative reads as success:
    // `assignRole(user, "admni")` that silently no-ops grants nothing and
    // says nothing.
    const error = await captureError(harness.registrar.findRole("nope"));

    expect(error).toBeInstanceOf(RoleNotFoundError);
  });

  it("throws on an unknown permission name", async () => {
    const error = await captureError(harness.registrar.findPermission("nope"));

    expect(error).toBeInstanceOf(PermissionNotFoundError);
  });

  it("does not find a role created under another guard", async () => {
    await harness.registrar.createRole("admin", { guard: "api" });

    const error = await captureError(harness.registrar.findRole("admin"));

    expect(error).toBeInstanceOf(RoleNotFoundError);
  });

  it("findOrCreateRole is idempotent", async () => {
    const first = await harness.registrar.findOrCreateRole("admin");
    const second = await harness.registrar.findOrCreateRole("admin");

    expect(second.id).toBe(first.id);
    expect(await Role.query().count()).toBe(1);
  });

  it("findOrCreatePermission is idempotent", async () => {
    const first = await harness.registrar.findOrCreatePermission("posts.edit");
    const second = await harness.registrar.findOrCreatePermission("posts.edit");

    expect(second.id).toBe(first.id);
    expect(await Permission.query().count()).toBe(1);
  });
});

describe("guard resolution", () => {
  it("throws when no guard can be resolved", async () => {
    // `auth` is not bound in the harness, so with config cleared there is
    // nothing left to fall back to. Failing beats stamping "", which
    // would create a role no check could ever match.
    const bare = await createHarness();
    bare.app.config.set("permissions", {});
    const registrar = bare.registrar;

    // The registrar captured its resolved config at construction, so
    // rebuild one through the provider to see the empty config.
    bare.provider.register();

    try {
      expect(() => registrar.guardName({ guard: "" })).toThrow(UnresolvedGuardError);
    } finally {
      bare.cleanup();
    }
  });

  it("prefers an explicit guard over config", () => {
    expect(harness.registrar.guardName({ guard: "api" })).toBe("api");
    expect(harness.registrar.guardName()).toBe("web");
  });
});

describe("role permissions", () => {
  beforeEach(async () => {
    await harness.registrar.createRole("editor");
    await harness.registrar.createPermission("posts.edit");
    await harness.registrar.createPermission("posts.delete");
  });

  it("grants permissions to a role", async () => {
    await harness.registrar.givePermissionToRole("editor", ["posts.edit", "posts.delete"]);

    const role = (await harness.registrar.map()).roleByName.get("web\u0000editor");

    expect(role?.permissionIds).toHaveLength(2);
  });

  it("is idempotent, so re-granting does not raise on the composite primary key", async () => {
    await harness.registrar.givePermissionToRole("editor", "posts.edit");
    await harness.registrar.givePermissionToRole("editor", ["posts.edit", "posts.delete"]);

    expect(await DB.table("role_has_permissions").count()).toBe(2);
  });

  it("revokes a permission from a role", async () => {
    await harness.registrar.givePermissionToRole("editor", ["posts.edit", "posts.delete"]);
    await harness.registrar.revokePermissionFromRole("editor", "posts.edit");

    const role = (await harness.registrar.map()).roleByName.get("web\u0000editor");

    expect(role?.permissionIds).toHaveLength(1);
  });

  it("syncs to exactly the given list", async () => {
    await harness.registrar.givePermissionToRole("editor", "posts.edit");
    await harness.registrar.syncRolePermissions("editor", "posts.delete");

    const map = await harness.registrar.map();
    const role = map.roleByName.get("web\u0000editor");

    expect(role?.permissionIds.map((id) => map.permissionById.get(id)?.name)).toEqual([
      "posts.delete",
    ]);
  });

  it("syncs an empty list to nothing", async () => {
    // The behaviour everyone gets wrong. The framework's own `detach([])`
    // is a deliberate no-op, so passing `request.input("permissions")`
    // through that API silently keeps the old set.
    await harness.registrar.givePermissionToRole("editor", ["posts.edit", "posts.delete"]);
    await harness.registrar.syncRolePermissions("editor", []);

    expect(await DB.table("role_has_permissions").count()).toBe(0);
  });

  it("cascades the pivot rows when a role is deleted", async () => {
    await harness.registrar.givePermissionToRole("editor", ["posts.edit", "posts.delete"]);
    await harness.registrar.deleteRole("editor");

    expect(await DB.table("role_has_permissions").count()).toBe(0);
  });

  it("cascades the pivot rows when a permission is deleted", async () => {
    await harness.registrar.givePermissionToRole("editor", "posts.edit");
    await harness.registrar.deletePermission("posts.edit");

    expect(await DB.table("role_has_permissions").count()).toBe(0);
  });
});
