import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe("disk resolution", () => {
  it("resolves the storage default when nothing is configured", () => {
    expect(harness.media.disk()).toBe(harness.disk);
  });

  it("resolves a named disk", () => {
    expect(harness.media.disk("public")).toBe(harness.publicDisk);
  });

  it("resolves the configured media disk over the storage default", async () => {
    const configured = await createHarness({ disk: "public" });

    expect(configured.media.disk()).toBe(configured.publicDisk);

    await configured.cleanup();
  });

  it("treats a row's null disk as the default, not as a missing disk", async () => {
    // A row stores `null` for "the default disk", so that a row written
    // before a `storage.default` change still reads from whatever the
    // default is now. Collapsing null to undefined is what makes
    // `Storage.disk(undefined)` resolve it at read time.
    const configured = await createHarness({ disk: "public" });

    expect(configured.media.disk(null)).toBe(configured.publicDisk);

    await configured.cleanup();
  });
});

describe("diskName", () => {
  it("returns null when the row should follow the default", () => {
    expect(harness.media.diskName()).toBeNull();
    expect(harness.media.diskName(null)).toBeNull();
  });

  it("returns the configured media disk, so the row pins it", async () => {
    const configured = await createHarness({ disk: "public" });

    expect(configured.media.diskName()).toBe("public");

    await configured.cleanup();
  });

  it("prefers an explicit disk over config", async () => {
    const configured = await createHarness({ disk: "public" });

    expect(configured.media.diskName("local")).toBe("local");

    await configured.cleanup();
  });
});

describe("isPublic", () => {
  // This is the whole of what laravel-media's `config('media.public_disks')`
  // bought, derived from storage's own config instead of a second list
  // that could disagree with it.

  it("is true for a disk with a url prefix", () => {
    expect(harness.media.isPublic("public")).toBe(true);
  });

  it("is false for a disk with no url prefix", () => {
    expect(harness.media.isPublic("local")).toBe(false);
  });

  it("falls back to the storage default disk", () => {
    expect(harness.media.isPublic()).toBe(false);
    expect(harness.media.isPublic(null)).toBe(false);
  });

  it("does not throw on a private disk, unlike url()", () => {
    // `url()` throwing is storage's contract and its message is good,
    // but it makes `url()` useless as a predicate — which is exactly
    // why this method reads the config rather than catching.
    expect(() => harness.media.isPublic("local")).not.toThrow();
    expect(() => harness.disk.url("a.png")).toThrow(/private disk/);
  });
});
