import { describe, expect, it } from "vitest";
import {
  buildMap,
  deserializeMap,
  mapKey,
  serializeMap,
  type MappedPermission,
  type MappedRole,
} from "../src/permission-map.js";

const roles: MappedRole[] = [
  { id: 10n, name: "admin", guardName: "web", permissionIds: [100n, 101n] },
  { id: 11n, name: "admin", guardName: "api", permissionIds: [] },
];

const permissions: MappedPermission[] = [
  { id: 100n, name: "posts.edit", guardName: "web" },
  { id: 101n, name: "posts.delete", guardName: "web" },
];

describe("permission map", () => {
  it("survives a JSON round trip", () => {
    // The whole reason this module exists. `RedisCacheStore` and
    // `FileCacheStore` persist with JSON.stringify, which THROWS on a
    // bigint, and `ArrayCacheStore` does not — so a map carrying raw
    // bigints passes every test on the default store and fails the
    // moment an app configures redis. Simulating the real store's
    // serialisation here is what makes that a test failure instead of a
    // production incident.
    const map = buildMap(roles, permissions);

    const revived = deserializeMap(JSON.parse(JSON.stringify(serializeMap(map))));

    expect(revived.roles).toEqual(roles);
    expect(revived.permissions).toEqual(permissions);
  });

  it("rejects a bigint reaching JSON.stringify, which is why ids are serialised", () => {
    // Pins the premise rather than the code: if a future Node made this
    // work, the string conversion would become dead weight rather than
    // load-bearing.
    expect(() => JSON.stringify({ id: 1n })).toThrow(TypeError);
  });

  it("indexes by guard and name together, so one guard cannot answer another's lookup", () => {
    const map = buildMap(roles, permissions);

    expect(map.roleByName.get(mapKey("web", "admin"))?.id).toBe(10n);
    expect(map.roleByName.get(mapKey("api", "admin"))?.id).toBe(11n);
    expect(map.roleByName.get(mapKey("mobile", "admin"))).toBeUndefined();
  });

  it("indexes by id", () => {
    const map = buildMap(roles, permissions);

    expect(map.roleById.get(10n)?.name).toBe("admin");
    expect(map.permissionById.get(101n)?.name).toBe("posts.delete");
  });

  it("separates keys that would collide under a printable separator", () => {
    // A permission name is app-chosen and may contain a colon
    // ("billing:view" is ordinary), so a `:` separator would make
    // ("web", "a:b") and ("web:a", "b") the same key — and the collision
    // would grant a permission nobody assigned.
    expect(mapKey("web", "a:b")).not.toBe(mapKey("web:a", "b"));
  });

  it("builds an empty map rather than failing for an app with no roles", () => {
    const map = buildMap([], []);

    expect(map.roles).toEqual([]);
    expect(map.roleByName.size).toBe(0);
  });
});
