import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "@mahiframework/datetime";
import { MediaFile } from "../src/models/media-file.model.js";
import {
  createHarness,
  makeTenant,
  makeUser,
  User,
  type Harness,
} from "./__fixtures__/test-app.js";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

/** The columns every row needs, so a test only states what it cares about. */
function attributes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model_type: null,
    model_id: null,
    collection: null,
    disk: null,
    path: "8c19165c/9b72/4d57/90ae/21d7b362a9f3.png",
    original_filename: "photo.png",
    size: 1024,
    mime_type: "image/png",
    extension: "png",
    checksum_hash: "a".repeat(64),
    checksum_algo: "sha256",
    image_width: null,
    image_height: null,
    order: 0,
    custom_properties: null,
    ...overrides,
  };
}

describe("the media table", () => {
  it("assigns an auto-increment id", async () => {
    const media = await MediaFile.create(attributes());

    // An auto-increment key is 64-bit on every engine, so it reads back
    // as a `bigint`.
    expect(typeof media.id).toBe("bigint");
    expect(media.id).toBeGreaterThan(0n);
  });

  it("round-trips every column", async () => {
    const created = await MediaFile.create(
      attributes({
        collection: "photos",
        disk: "public",
        size: 2_147_483_648,
        image_width: 4000,
        image_height: 3000,
        order: 3,
        custom_properties: { alt: "A cat" },
      }),
    );

    const found = await MediaFile.findOrFail(created.id);

    expect(found.collection).toBe("photos");
    expect(found.disk).toBe("public");
    expect(found.size).toBe(2_147_483_648);
    expect(found.image_width).toBe(4000);
    expect(found.order).toBe(3);
    expect(found.custom_properties).toEqual({ alt: "A cat" });
    expect(found.created_at).toBeInstanceOf(DateTime);
    expect(found.updated_at).toBeInstanceOf(DateTime);
  });

  it("stores a size past a 32-bit integer", async () => {
    // `unsignedBigInteger`, not `unsignedInteger`: a 5GB video is an
    // ordinary upload and would overflow at 4294967295.
    const created = await MediaFile.create(attributes({ size: 5_000_000_000 }));

    expect((await MediaFile.findOrFail(created.id)).size).toBe(5_000_000_000);
  });

  it("reads `size` back as a number, not a bigint", async () => {
    // The column is an `unsignedBigInteger`, so the driver hands back a
    // `bigint` and `Cast.integer()` narrows it. That matters because
    // `JSON.stringify` throws on a `bigint` — deliberately — and unlike
    // `id`, which every resource stringifies by convention, nothing
    // would think to do that for a size. Without the cast, serialising
    // a media row would fail on a column nobody suspects.
    const created = await MediaFile.create(attributes({ size: 5_000_000_000 }));
    const found = await MediaFile.findOrFail(created.id);

    expect(typeof found.size).toBe("number");
    expect(() => JSON.stringify({ size: found.size })).not.toThrow();
  });

  it("accepts an empty extension", async () => {
    // A file with no discernible type is a real thing. The column is NOT
    // NULL and `""` means "none", so no reader has to branch on null.
    const created = await MediaFile.create(attributes({ extension: "", mime_type: "text/plain" }));

    expect((await MediaFile.findOrFail(created.id)).extension).toBe("");
  });

  it("allows both morph columns to be null", async () => {
    // The `belongsToMedia` case: the owner holds the foreign key, so the
    // media row records no owner at all.
    const created = await MediaFile.create(attributes());
    const found = await MediaFile.findOrFail(created.id);

    expect(found.model_type).toBeNull();
    expect(found.model_id).toBeNull();
  });
});

describe("model_id is text, not bigInteger", () => {
  it("holds an integer-keyed owner", async () => {
    const user = await makeUser();

    const created = await MediaFile.create(
      attributes({ model_type: User.morphAlias(), model_id: String(user.id) }),
    );

    expect((await MediaFile.findOrFail(created.id)).model_id).toBe(String(user.id));
  });

  it("holds a uuid-keyed owner", async () => {
    // The whole justification for the text column. `permissions` makes
    // its `model_id` a bigInteger because the value is bound raw into a
    // pivot query, and documents integer-keyed assignees as a hard
    // limit. Nothing here does that, so any key type can own media — and
    // a suite with only bigint owners would let this regress to
    // `unsignedBigInteger` unnoticed, which is what `nullableMorphs()`
    // would have given it.
    const tenant = await makeTenant();

    const created = await MediaFile.create(
      attributes({ model_type: "Tenant", model_id: tenant.id }),
    );

    expect((await MediaFile.findOrFail(created.id)).model_id).toBe(tenant.id);
  });

  it("does not confuse two owners sharing a key across types", async () => {
    const user = await makeUser();

    await MediaFile.create(
      attributes({ model_type: "User", model_id: String(user.id), collection: "photos" }),
    );
    await MediaFile.create(
      attributes({ model_type: "Team", model_id: String(user.id), collection: "logos" }),
    );

    const owned = await MediaFile.for("User", user.id).get();

    expect(owned.all().map((row) => row.collection)).toEqual(["photos"]);
  });
});

describe("scopes", () => {
  it("orders a record's media by `order`", async () => {
    const user = await makeUser();
    const owner = { model_type: "User", model_id: String(user.id) };

    await MediaFile.create(attributes({ ...owner, order: 3, original_filename: "c.png" }));
    await MediaFile.create(attributes({ ...owner, order: 1, original_filename: "a.png" }));
    await MediaFile.create(attributes({ ...owner, order: 2, original_filename: "b.png" }));

    const found = await MediaFile.for("User", user.id).get();

    expect(found.all().map((row) => row.original_filename)).toEqual(["a.png", "b.png", "c.png"]);
  });

  it("scopes to one collection across owners", async () => {
    const one = await makeUser();
    const two = await makeUser();

    await MediaFile.create(
      attributes({ model_type: "User", model_id: String(one.id), collection: "photos" }),
    );
    await MediaFile.create(
      attributes({ model_type: "User", model_id: String(two.id), collection: "photos" }),
    );
    await MediaFile.create(
      attributes({ model_type: "User", model_id: String(two.id), collection: "docs" }),
    );

    expect((await MediaFile.inCollection("photos").get()).all()).toHaveLength(2);
  });
});
