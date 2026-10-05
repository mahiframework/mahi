import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Role } from "../src/models/role.model.js";
import { withPermissionCache } from "../src/request-cache.js";
import { createHarness, makeUser, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(() => harness.cleanup());

describe("the cached map", () => {
  it("loads once and serves every subsequent read from cache", async () => {
    await harness.registrar.createRole("admin");

    // A `put` is the loader having run: `remember()` only writes on a
    // miss. Counting writes rather than reads is what distinguishes
    // "cached" from "re-read every time but cheap".
    const put = vi.spyOn(harness.store, "put");

    await harness.registrar.map();
    await harness.registrar.map();
    await harness.registrar.map();

    expect(put).toHaveBeenCalledTimes(1);
  });

  it("caches a JSON-safe payload, not raw bigints", async () => {
    await harness.registrar.createRole("admin");
    await harness.registrar.createPermission("posts.edit");
    await harness.registrar.givePermissionToRole("admin", "posts.edit");
    await harness.registrar.map();

    const cached = await harness.store.get("mahi.permissions");

    // The redis/file trap. `ArrayCacheStore` would hold a bigint happily,
    // so without asserting the stored SHAPE this suite would pass while
    // any app configuring a serialising store crashed on first check.
    expect(() => JSON.stringify(cached)).not.toThrow();
  });

  it("forgets exactly its own key, never the whole store", async () => {
    // There are no cache tags, so flush-by-pattern is impossible and
    // `flush()` would take out the app's entire cache to fix a problem
    // with five tables.
    await harness.store.put("unrelated", "keep me");
    await harness.registrar.createRole("admin");
    await harness.registrar.forgetCache();

    expect(await harness.store.get("mahi.permissions")).toBeUndefined();
    expect(await harness.store.get("unrelated")).toBe("keep me");
  });

  it("reloads after a write through the registrar", async () => {
    await harness.registrar.createRole("admin");
    expect((await harness.registrar.map()).roles).toHaveLength(1);

    await harness.registrar.createRole("editor");

    expect((await harness.registrar.map()).roles).toHaveLength(2);
  });

  it("reloads after a Role written outside the registrar", async () => {
    // The hole the model-event listener exists to close: a seeder, a
    // migration, or an admin screen saving through the model never
    // touches `forgetCache()`, so without the listener the map would keep
    // answering from the old names until the TTL expired.
    await harness.registrar.createRole("admin");
    expect((await harness.registrar.map()).roles).toHaveLength(1);

    await Role.create({ name: "smuggled", guard_name: "web" });

    expect((await harness.registrar.map()).roles).toHaveLength(2);
  });

  it("reloads after a Role renamed outside the registrar", async () => {
    const role = await harness.registrar.createRole("admin");
    await harness.registrar.map();

    await Role.update(role.id, { name: "superadmin" });

    const map = await harness.registrar.map();

    expect(map.roleByName.has("web\u0000superadmin")).toBe(true);
    expect(map.roleByName.has("web\u0000admin")).toBe(false);
  });

  it("honours a configured key and TTL", async () => {
    const custom = await createHarness({ cache: { key: "acme.perms", ttlSeconds: 60 } });

    try {
      await custom.registrar.createRole("admin");
      await custom.registrar.map();

      expect(await custom.store.get("acme.perms")).toBeDefined();
      expect(await custom.store.get("mahi.permissions")).toBeUndefined();
    } finally {
      custom.cleanup();
    }
  });
});

describe("the per-request assignment memo", () => {
  it("reads a subject's assignments once inside a scope", async () => {
    await harness.registrar.createRole("admin");
    await harness.registrar.createPermission("posts.edit");
    await harness.registrar.givePermissionToRole("admin", "posts.edit");
    const user = await makeUser();
    await harness.registrar.assignRole(user, "admin");

    await withPermissionCache(async () => {
      // Five checks, which is what a controller with five `can()` calls
      // produces through the gate hook. Without the memo that is ten
      // queries against rows that cannot have changed.
      for (let index = 0; index < 5; index++) {
        expect(await harness.registrar.hasPermissionTo(user, "posts.edit")).toBe(true);
      }
    });
  });

  it("sees a write made inside the same scope", async () => {
    // The memo is cleared by assignment writes rather than patched;
    // patching would mean keeping two representations in step.
    await harness.registrar.createRole("admin");
    const user = await makeUser();

    await withPermissionCache(async () => {
      expect(await harness.registrar.hasRole(user, "admin")).toBe(false);

      await harness.registrar.assignRole(user, "admin");

      expect(await harness.registrar.hasRole(user, "admin")).toBe(true);
    });
  });

  it("does not leak between scopes", async () => {
    // A long-lived worker would otherwise serve one request's answers to
    // the next.
    await harness.registrar.createRole("admin");
    const user = await makeUser();

    await withPermissionCache(async () => {
      expect(await harness.registrar.hasRole(user, "admin")).toBe(false);
    });

    await harness.registrar.assignRole(user, "admin");

    await withPermissionCache(async () => {
      expect(await harness.registrar.hasRole(user, "admin")).toBe(true);
    });
  });

  it("works with no scope at all, for a job or a CLI command", async () => {
    await harness.registrar.createRole("admin");
    const user = await makeUser();
    await harness.registrar.assignRole(user, "admin");

    expect(await harness.registrar.hasRole(user, "admin")).toBe(true);
  });
});
