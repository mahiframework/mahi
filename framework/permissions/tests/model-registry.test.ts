import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelCreated } from "@mahiframework/database";
import { Permission } from "../src/models/permission.model.js";
import { permissionModels, usePermissionModels } from "../src/models/registry.js";
import { Role } from "../src/models/role.model.js";
import { createHarness, makeUser, type Harness } from "./__fixtures__/test-app.js";

/**
 * An app subclass, the `Extended<>` story from `docs/extending-models`.
 *
 * Adds behaviour rather than columns, which is what a test can assert
 * without a second migration — the point under test is which class the
 * PACKAGE's own queries produce, not what the subclass holds.
 *
 * A getter, matching what the docs tell an app to write. That accessors
 * resolve attributes at all is pinned in `framework/database`'s own
 * suite; here it only has to keep working through the registry.
 */
class AppRole extends Role {
  get shoutedName(): string {
    return this.name.toUpperCase();
  }
}

class AppPermission extends Permission {
  get shoutedName(): string {
    return this.name.toUpperCase();
  }
}

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(() => harness.cleanup());

describe("usePermissionModels", () => {
  it("defaults to the package's own classes", () => {
    expect(permissionModels.role).toBe(Role);
    expect(permissionModels.permission).toBe(Permission);
  });

  it("makes the package's own writes produce the subclass", async () => {
    usePermissionModels({ role: AppRole });

    const role = await harness.registrar.createRole("admin");

    expect(role).toBeInstanceOf(AppRole);
    expect((role as AppRole).shoutedName).toBe("ADMIN");
  });

  it("makes the package's own reads produce the subclass", async () => {
    usePermissionModels({ role: AppRole });

    await harness.registrar.createRole("admin");

    expect(await harness.registrar.findRole("admin")).toBeInstanceOf(AppRole);
  });

  it("covers findOrCreate on both the hit and the miss", async () => {
    usePermissionModels({ role: AppRole, permission: AppPermission });

    expect(await harness.registrar.findOrCreateRole("admin")).toBeInstanceOf(AppRole);
    expect(await harness.registrar.findOrCreateRole("admin")).toBeInstanceOf(AppRole);
    expect(await harness.registrar.findOrCreatePermission("posts.edit")).toBeInstanceOf(
      AppPermission,
    );
  });

  it("overrides each class independently", async () => {
    usePermissionModels({ permission: AppPermission });

    expect(await harness.registrar.createRole("admin")).toBeInstanceOf(Role);
    expect(await harness.registrar.createRole("admin2")).not.toBeInstanceOf(AppRole);
    expect(await harness.registrar.createPermission("posts.edit")).toBeInstanceOf(AppPermission);
  });

  it("keeps assignments working through the subclass", async () => {
    usePermissionModels({ role: AppRole, permission: AppPermission });

    const user = await makeUser();

    await harness.registrar.createRole("admin");
    await harness.registrar.createPermission("posts.edit");
    await harness.registrar.givePermissionToRole("admin", "posts.edit");
    await harness.registrar.assignRole(user, "admin");

    expect(await harness.registrar.hasPermissionTo(user, "posts.edit")).toBe(true);
  });

  it("accepts a subclass instance as a role reference", async () => {
    usePermissionModels({ role: AppRole });

    const role = await harness.registrar.createRole("admin");
    const user = await makeUser();

    // `instanceof Role` is the check, so a subclass satisfies it.
    await harness.registrar.assignRole(user, role);

    expect(await harness.registrar.hasRole(user, "admin")).toBe(true);
  });

  it("deletes through the subclass, cascading the pivots", async () => {
    usePermissionModels({ role: AppRole });

    const user = await makeUser();

    await harness.registrar.createRole("admin");
    await harness.registrar.assignRole(user, "admin");
    await harness.registrar.deleteRole("admin");

    expect(await harness.registrar.hasRole(user, "admin")).toBe(false);
  });

  it("invalidates the cache for a write through the subclass", async () => {
    // The listener matches on class identity, so it has to read the
    // registry — otherwise a seeder using `AppRole.create()` would leave
    // the map stale until the TTL.
    usePermissionModels({ role: AppRole });

    await harness.registrar.createRole("admin");
    await harness.registrar.map();

    const created = await AppRole.create({ name: "editor", guard_name: "web" });

    await harness.events.dispatch(
      new ModelCreated(AppRole as never, { id: created.id } as never, "created" as never),
    );

    expect(await harness.store.get("mahi.permissions")).toBeUndefined();
  });

  it("registers the subclass for the queue codec", () => {
    usePermissionModels({ role: AppRole, permission: AppPermission });

    expect(harness.provider.models()).toEqual([AppRole, AppPermission]);
  });

  it("is reset between tests, since the registry is module-global", () => {
    // The assertion that makes every case above honest: the harness
    // cleanup restores the package's classes, so an override cannot leak
    // into the next file.
    expect(permissionModels.role).toBe(Role);
  });
});
