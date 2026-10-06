import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DB } from "@mahiframework/database";
import { DateTime } from "@mahiframework/datetime";
import { SettingRecord } from "../src/models/setting-record.model.js";
import { createHarness, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(() => harness.cleanup());

describe("the cached map", () => {
  it("populates one key, named from config", async () => {
    await harness.registry.get("app_name");

    expect(await harness.store.has("mahi.settings")).toBe(true);
  });

  it("caches an empty object rather than undefined for an app with no rows", async () => {
    // `remember()` treats `undefined` as its miss sentinel, so a loader
    // returning it would re-query on every single read.
    await harness.registry.get("app_name");

    expect(await harness.store.get("mahi.settings")).toEqual({});
  });

  it("serves later reads from the cache, not the database", async () => {
    await harness.registry.set("app_name", "Cached");
    await harness.registry.get("app_name");

    // Bypass the registry so the cache is now stale on purpose.
    await DB.table("settings").where("key", "app_name").update({ value: '"Changed"' });

    expect(await harness.registry.get("app_name")).toBe("Cached");
  });

  it("holds only JSON-safe values, so a file or redis store can persist it", async () => {
    // `FileCacheStore` and `RedisCacheStore` persist with
    // `JSON.stringify`, which throws on a `bigint`, while
    // `ArrayCacheStore` passes anything through — so a payload that is
    // not JSON-safe fails only once an app switches store, i.e. in
    // production. Round-tripping here is what makes that a test failure
    // instead.
    await harness.registry.setMany({
      app_name: "Acme",
      import_batch_size: 250,
      import_feature_enabled: true,
      maintenance_until: DateTime.parse("2026-03-04T05:06:07Z", "UTC"),
      allowed_domains: ["a.test"],
      branding: { primary: "#112233" },
    });
    await harness.registry.all();

    const cached = await harness.store.get("mahi.settings");

    expect(JSON.parse(JSON.stringify(cached))).toEqual(cached);
  });

  it("caches the encoded form, decoding only after the boundary", async () => {
    // The cached payload is the raw column strings. That is what keeps
    // it JSON-safe by construction rather than by review.
    await harness.registry.set("maintenance_until", DateTime.parse("2026-03-04T05:06:07Z", "UTC"));
    await harness.registry.get("maintenance_until");

    const cached = (await harness.store.get("mahi.settings")) as Record<string, string>;

    expect(typeof cached["maintenance_until"]).toBe("string");
    expect(await harness.registry.get("maintenance_until")).toBeInstanceOf(DateTime);
  });
});

describe("invalidation", () => {
  it("forgets the cache on a write", async () => {
    await harness.registry.get("app_name");
    await harness.registry.set("app_name", "Acme");

    expect(await harness.registry.get("app_name")).toBe("Acme");
  });

  it("forgets the cache once for a batch, not per setting", async () => {
    await harness.registry.get("app_name");
    await harness.registry.setMany({ app_name: "A", import_batch_size: 5 });

    expect(await harness.registry.get("app_name")).toBe("A");
    expect(await harness.registry.get("import_batch_size")).toBe(5);
  });

  it("forgets the cache on forget()", async () => {
    await harness.registry.set("app_name", "Acme");
    await harness.registry.get("app_name");
    await harness.registry.forget("app_name");

    expect(await harness.registry.get("app_name")).toBe("Mahi");
  });

  it("forgets exactly one key, leaving the rest of the app's cache alone", async () => {
    // `@mahiframework/cache` has no tags, so there is no flush-by-pattern
    // — and `flush()` would take out everything the app had cached.
    await harness.store.put("unrelated", "keep me");
    await harness.registry.get("app_name");
    await harness.registry.forgetCache();

    expect(await harness.store.get("unrelated")).toBe("keep me");
    expect(await harness.store.has("mahi.settings")).toBe(false);
  });

  it("forgets the cache when a row is written through the model", async () => {
    // The listener's whole purpose: writes the registry never sees. A
    // seeder, a migration backfill, an admin screen going straight to
    // the ORM. Without it the old value would be served until the TTL.
    await harness.registry.get("app_name");

    await SettingRecord.create({
      key: "app_name",
      value: '"From a seeder"',
      edited_by_user_id: null,
    });

    expect(await harness.registry.get("app_name")).toBe("From a seeder");
  });

  it("forgets the cache when a row is deleted through the model", async () => {
    await harness.registry.set("app_name", "Acme");
    await harness.registry.get("app_name");

    await SettingRecord.delete("app_name");

    expect(await harness.registry.get("app_name")).toBe("Mahi");
  });

  it("ignores model events for other tables", async () => {
    // The listener filters on model identity, so an app writing any
    // other model does not pay a cache invalidation per row.
    await harness.registry.get("app_name");

    await DB.table("users").insert({ id: 1n, email: "a@b.test" });

    expect(await harness.store.has("mahi.settings")).toBe(true);
  });
});

describe("configuration", () => {
  it("honours a configured key, store and TTL", async () => {
    const configured = await createHarness({
      config: { cache: { key: "custom.settings", ttlSeconds: 60 } },
    });

    await configured.registry.get("app_name");

    expect(await configured.store.has("custom.settings")).toBe(true);
    expect(await configured.store.has("mahi.settings")).toBe(false);

    configured.cleanup();
  });
});
