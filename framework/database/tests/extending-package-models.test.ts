import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { DateTime } from "@mahiframework/datetime";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN, SCHEMA_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import { Cast } from "../src/casts.js";
import { Schema } from "../src/schema/schema-facade.js";
import { belongsToMany } from "../src/relations.js";
import type { BelongsToMany, Extended } from "../src/markers.js";

/**
 * The mechanics behind `docs/extending-models/`: how an application
 * takes a model a PACKAGE owns and extends it.
 *
 * Two independent halves, and the docs are only sound if both hold:
 *
 *  - BEHAVIOUR, by subclassing. The finders are this-polymorphic, so an
 *    inherited `find()` must return the subclass, and per-class state
 *    (casts, scopes) must not leak to the parent or to siblings.
 *  - WIRING, by a late-bound registry. A package that references its
 *    models through a mutable registry rather than a direct import can
 *    be pointed at the subclass, INCLUDING from relation thunks, which
 *    resolve at `with()` time rather than at module evaluation.
 *
 * The `Extended<>` half of the story (merged-in columns skipping the
 * cast lint) is compile-time only and is pinned in `types.test-d.ts`;
 * what is checked here is that such a column still round-trips through
 * a cast declared on the subclass.
 */

// ---------------------------------------------------------------------
// Stand-in for a package: two models wired through a registry.
// ---------------------------------------------------------------------

interface PermissionAttributes {
  id: string;
  name: string;
  roles: BelongsToMany<Role>;
}

interface RoleAttributes {
  id: string;
  name: string;
  permissions: BelongsToMany<Permission>;
  /** Merged in by the "app" below; see `Extended<>`. */
  archived_at: Extended<DateTime | null>;
}

class Permission extends Model<PermissionAttributes>()({
  table: "permissions",
  primaryKey: "id",
  timestamps: false,
}) {
  static override relationships = {
    roles: belongsToMany(() => registry.role, {
      pivotTable: "role_permissions",
      foreignPivotKey: "permission_id",
      relatedPivotKey: "role_id",
    }),
  };
}

class Role extends Model<RoleAttributes>()({
  table: "roles",
  primaryKey: "id",
  timestamps: false,
}) {
  static override relationships = {
    permissions: belongsToMany(() => registry.permission, {
      pivotTable: "role_permissions",
      foreignPivotKey: "role_id",
      relatedPivotKey: "permission_id",
    }),
  };
}

interface Registry {
  role: typeof Role;
  permission: typeof Permission;
}

const registry: Registry = { role: Role, permission: Permission };

/** What the package's own code calls, always through the registry. */
const packageCode = {
  async createRole(name: string): Promise<Role> {
    return registry.role.create({ id: `r-${name}`, name, archived_at: null });
  },
  async findRole(id: string): Promise<Role | undefined> {
    return registry.role.find(id);
  },
};

// ---------------------------------------------------------------------
// Stand-in for the application's override.
// ---------------------------------------------------------------------

class AppRole extends Role {
  /**
   * `archived_at` is merged in by the app, so the package's factory
   * call never saw it and could not have cast it. Registering it here
   * is what `Extended<>` hands responsibility for.
   */
  static override casts = { ...Role.casts, archived_at: Cast.datetime() };

  get isArchived(): boolean {
    return this.archived_at !== null;
  }
}

class AppPermission extends Permission {
  shout(): string {
    return this.name.toUpperCase();
  }
}

let app: Application;

beforeEach(async () => {
  app = new Application();
  const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
  manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
  app.instance(DATABASE_TOKEN, manager);
  app.bind(SCHEMA_TOKEN, () => manager.schema());
  setCurrentApp(app);

  await Schema.create("roles", (table) => {
    table.string("id").primary();
    table.string("name");
    table.string("archived_at").nullable();
  });
  await Schema.create("permissions", (table) => {
    table.string("id").primary();
    table.string("name");
  });
  await Schema.create("role_permissions", (table) => {
    table.string("role_id");
    table.string("permission_id");
  });

  registry.role = Role;
  registry.permission = Permission;
});

afterEach(() => {
  clearCurrentApp();
});

describe("subclassing a package model", () => {
  it("returns the subclass from inherited finders", async () => {
    await Role.create({ id: "r1", name: "admin", archived_at: null });

    const found = await AppRole.find("r1");

    expect(found).toBeInstanceOf(AppRole);
    expect(found?.name).toBe("admin");
  });

  it("writes through the subclass to the package's table", async () => {
    await AppRole.create({ id: "r2", name: "editor", archived_at: null });

    const viaPackage = await Role.find("r2");

    expect(viaPackage).toBeDefined();
    expect(viaPackage).toBeInstanceOf(Role);
    expect(viaPackage).not.toBeInstanceOf(AppRole);
  });

  it("inherits the parent's table, key and casts", () => {
    expect(AppRole.table).toBe("roles");
    expect(AppRole.primaryKeyColumn).toBe("id");
    expect(AppPermission.table).toBe("permissions");
  });

  it("casts an app-added column without touching the parent", async () => {
    // Seeded as the driver would store it. The lenient `ModelType |
    // DbType` write union is derived from the casts in the model's
    // CONFIG, and this cast lives on the subclass static instead, so
    // the raw form needs the cast through here.
    await Role.query().insert({
      id: "r3",
      name: "admin",
      archived_at: "2026-01-01T00:00:00.000Z" as unknown as DateTime,
    });

    const viaSubclass = await AppRole.findOrFail("r3");
    const viaPackage = await Role.findOrFail("r3");

    expect(viaSubclass.archived_at).toBeInstanceOf(DateTime);
    expect(viaSubclass.isArchived).toBe(true);
    // The package's own class never learned about the column's type.
    expect(typeof (viaPackage as unknown as Record<string, unknown>)["archived_at"]).toBe("string");
  });

  it("round-trips an app-added column on write", async () => {
    const now = DateTime.now();
    await AppRole.create({ id: "r4", name: "admin", archived_at: now });

    const reread = await AppRole.findOrFail("r4");

    expect(reread.archived_at).toBeInstanceOf(DateTime);
    // Compared as an instant: the cast stores UTC, so the re-read value
    // is the same moment rendered in a different zone.
    expect(reread.archived_at?.valueOf()).toBe(now.valueOf());
  });

  it("does not leak a global scope onto the parent", async () => {
    class ScopedRole extends Role {}
    ScopedRole.addGlobalScope({
      apply(builder) {
        builder.where("name", "=", "no-such-role");
      },
    });

    await Role.create({ id: "r5", name: "admin", archived_at: null });

    expect((await ScopedRole.query().get()).all()).toHaveLength(0);
    expect((await Role.query().get()).all()).toHaveLength(1);
  });
});

describe("swapping a package model through a registry", () => {
  it("makes the package's own reads and writes use the subclass", async () => {
    registry.role = AppRole;

    const created = await packageCode.createRole("admin");
    expect(created).toBeInstanceOf(AppRole);

    const found = await packageCode.findRole(created.id);
    expect(found).toBeInstanceOf(AppRole);
  });

  it("resolves relation thunks to the swapped class at load time", async () => {
    await Role.create({ id: "r1", name: "admin", archived_at: null });
    await Permission.create({ id: "p1", name: "posts.edit" });
    await app
      .make<DatabaseManager>(DATABASE_TOKEN)
      .driver()
      .kysely.insertInto("role_permissions")
      .values({ role_id: "r1", permission_id: "p1" })
      .execute();

    // Before: the package's own classes.
    const before = await Role.query().with("permissions").firstOrFail();
    expect(before.permissions?.all()[0]).toBeInstanceOf(Permission);
    expect(before.permissions?.all()[0]).not.toBeInstanceOf(AppPermission);

    // The swap happens long after both modules were evaluated, which is
    // the case a direct `import` could not support.
    registry.role = AppRole;
    registry.permission = AppPermission;

    const after = await registry.role.query().with("permissions").firstOrFail();
    const permission = after.permissions?.all()[0];

    expect(after).toBeInstanceOf(AppRole);
    expect(permission).toBeInstanceOf(AppPermission);
    expect((permission as AppPermission).shout()).toBe("POSTS.EDIT");
  });
});
