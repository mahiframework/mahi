import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnacceptableMediaTypeError } from "../src/errors.js";
import { hasManyMedia } from "../src/builders/has-many-media.js";
import { format, resizeDown } from "../src/modifiers/index.js";
import { MediaFile } from "../src/models/media-file.model.js";
import * as bytes from "./__fixtures__/bytes.js";
import {
  captureError,
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

describe("hasManyMedia", () => {
  it("adds a file and stamps the owner and collection", async () => {
    const user = await makeUser();

    const added = await user.photos().add(bytes.PNG);
    const media = added.first();

    expect(media?.model_type).toBe("User");
    expect(media?.model_id).toBe(String(user.id));
    expect(media?.collection).toBe("photos");
  });

  it("appends rather than replacing", async () => {
    const user = await makeUser();

    await user.photos().add(bytes.PNG);
    await user.photos().add(bytes.JPEG);

    expect((await user.photos().get()).all()).toHaveLength(2);
  });

  it("adds several in one call, in order", async () => {
    const user = await makeUser();

    const added = await user.photos().add([bytes.PNG, bytes.JPEG, bytes.GIF]);

    expect(added.all().map((row) => row.order)).toEqual([1, 2, 3]);
  });

  it("orders from 1, so unordered stays distinguishable from first", async () => {
    const user = await makeUser();

    const added = await user.photos().add(bytes.PNG);

    expect(added.first()?.order).toBe(1);
  });

  it("continues the ordering across separate calls", async () => {
    const user = await makeUser();

    await user.photos().add([bytes.PNG, bytes.JPEG]);
    const third = await user.photos().add(bytes.GIF);

    expect(third.first()?.order).toBe(3);
  });

  it("scopes reads to its own collection", async () => {
    // The double duty: one `collection()` declaration both tags writes
    // and constrains reads, so the two cannot disagree.
    const user = await makeUser();

    await user.photos().add(bytes.PNG);
    await user.documents().add(bytes.PDF);

    expect((await user.photos().get()).all()).toHaveLength(1);
    expect((await user.documents().get()).all()).toHaveLength(1);
    expect((await user.photos().get()).first()?.mime_type).toBe("image/png");
  });

  it("does not see another owner's files", async () => {
    const one = await makeUser();
    const two = await makeUser();

    await one.photos().add(bytes.PNG);

    expect((await two.photos().get()).all()).toHaveLength(0);
  });

  it("works for a string-keyed owner", async () => {
    // `media.model_id` is TEXT precisely so that any key type can own
    // media. A suite with only bigint owners would miss a regression to
    // `unsignedBigInteger`.
    const tenant = await makeTenant();

    await tenant.attachments().add(bytes.PDF);

    const found = (await tenant.attachments().get()).all();

    expect(found).toHaveLength(1);
    expect(found[0]?.model_id).toBe(tenant.id);
  });

  it("counts without loading", async () => {
    const user = await makeUser();

    await user.photos().add([bytes.PNG, bytes.JPEG]);

    expect(await user.photos().count()).toBe(2);
  });

  it("deletes every file and row in the collection", async () => {
    const user = await makeUser();

    const added = await user.photos().add([bytes.PNG, bytes.JPEG]);
    const paths = added.all().map((row) => row.path);

    await user.photos().delete();

    expect((await user.photos().get()).all()).toHaveLength(0);

    for (const path of paths) {
      await harness.disk.assertMissing(path);
    }
  });

  it("leaves other collections alone when deleting", async () => {
    const user = await makeUser();

    await user.photos().add(bytes.PNG);
    await user.documents().add(bytes.PDF);

    await user.photos().delete();

    expect((await user.documents().get()).all()).toHaveLength(1);
  });

  it("exposes a query for reads beyond get()", async () => {
    const user = await makeUser();

    await user.photos().add([bytes.PNG, bytes.PDF]);

    const images = await user.photos().query().where("mime_type", "image/png").get();

    expect(images.all()).toHaveLength(1);
  });
});

describe("keepLatest", () => {
  it("evicts the oldest beyond the limit", async () => {
    const user = await makeUser();
    const capped = () => hasManyMedia(user).collection("photos").keepLatest(2);

    const first = await capped().add(bytes.PNG);
    await capped().add(bytes.JPEG);
    await capped().add(bytes.GIF);

    const remaining = (await user.photos().get()).all();

    expect(remaining).toHaveLength(2);
    expect(remaining.map((row) => row.id)).not.toContain(first.first()?.id);
  });

  it("deletes the evicted file too", async () => {
    const user = await makeUser();
    const capped = () => hasManyMedia(user).collection("photos").keepLatest(1);

    const first = await capped().add(bytes.PNG);
    const path = first.first()?.path ?? "";

    await capped().add(bytes.JPEG);

    await harness.disk.assertMissing(path);
  });

  it("does nothing below the limit", async () => {
    const user = await makeUser();

    await hasManyMedia(user).collection("photos").keepLatest(5).add(bytes.PNG);

    expect((await user.photos().get()).all()).toHaveLength(1);
  });

  it("is off when unset", async () => {
    const user = await makeUser();

    await user.photos().add([bytes.PNG, bytes.JPEG, bytes.GIF]);

    expect((await user.photos().get()).all()).toHaveLength(3);
  });
});

describe("hasOneMedia", () => {
  it("sets and reads a single file", async () => {
    const tenant = await makeTenant();

    await tenant.logo().set(bytes.PNG);

    expect((await tenant.logo().get())?.collection).toBe("logo");
  });

  it("replaces on set, leaving exactly one row", async () => {
    const tenant = await makeTenant();

    const first = await tenant.logo().set(bytes.PNG);
    await tenant.logo().set(bytes.JPEG);

    const current = await tenant.logo().get();

    expect(current?.mime_type).toBe("image/jpeg");
    expect(await MediaFile.find(first.id)).toBeUndefined();
    await harness.disk.assertMissing(first.path);
  });

  it("returns undefined when there is none", async () => {
    const tenant = await makeTenant();

    expect(await tenant.logo().get()).toBeUndefined();
  });

  it("deletes the row and the file", async () => {
    const tenant = await makeTenant();

    const logo = await tenant.logo().set(bytes.PNG);
    await tenant.logo().delete();

    expect(await tenant.logo().get()).toBeUndefined();
    await harness.disk.assertMissing(logo.path);
  });

  it("deleting nothing is a no-op", async () => {
    const tenant = await makeTenant();

    await expect(tenant.logo().delete()).resolves.toBeUndefined();
  });
});

describe("belongsToMedia", () => {
  it("sets the file and repoints the owner's key", async () => {
    const user = await makeUser();

    const avatar = await user.avatar().set(bytes.PNG);

    expect(user.avatar_id).toBe(avatar.id);
    expect((await user.avatar().get())?.id).toBe(avatar.id);
  });

  it("records no owner on the media row", async () => {
    // The owner holds the reference, so the row records none — which is
    // why the migration makes both morph columns nullable.
    const user = await makeUser();

    const avatar = await user.avatar().set(bytes.PNG);

    expect(avatar.model_type).toBeNull();
    expect(avatar.model_id).toBeNull();
  });

  it("persists the key change", async () => {
    const user = await makeUser();

    const avatar = await user.avatar().set(bytes.PNG);
    const reloaded = await User.findOrFail(user.id);

    expect(reloaded.avatar_id).toBe(avatar.id);
  });

  it("replaces the old file on set", async () => {
    const user = await makeUser();

    const first = await user.avatar().set(bytes.PNG);
    const second = await user.avatar().set(bytes.JPEG);

    expect(user.avatar_id).toBe(second.id);
    expect(await MediaFile.find(first.id)).toBeUndefined();
    await harness.disk.assertMissing(first.path);
  });

  it("returns undefined when the key is null", async () => {
    const user = await makeUser();

    expect(await user.avatar().get()).toBeUndefined();
  });

  it("nulls the key and deletes the file", async () => {
    const user = await makeUser();

    const avatar = await user.avatar().set(bytes.PNG);
    await user.avatar().delete();

    expect(user.avatar_id).toBeNull();
    expect(await MediaFile.find(avatar.id)).toBeUndefined();
    await harness.disk.assertMissing(avatar.path);
  });

  it("enforces its accept rules", async () => {
    const user = await makeUser();

    const error = await captureError(user.avatar().set(bytes.PDF));

    expect(error).toBeInstanceOf(UnacceptableMediaTypeError);
    expect(user.avatar_id).toBeNull();
  });
});

describe("the blueprint is immutable", () => {
  it("does not leak a per-call override into the next call", async () => {
    // laravel-media mutates a shared blueprint, so a per-call override
    // persists — behaviour its own suite pins with a "shares blueprint
    // configuration across instances" test. Cloning makes the override
    // mean "for this call", which is what a reader expects.
    const user = await makeUser();
    const photos = user.photos();

    const narrowed = photos.accept({ mimes: ["image/png"] });

    await expect(narrowed.add(bytes.JPEG)).rejects.toThrow(UnacceptableMediaTypeError);

    // The original builder is unaffected.
    await expect(photos.add(bytes.JPEG)).resolves.toBeDefined();
  });

  it("returns a new builder from every fluent method", async () => {
    const user = await makeUser();
    const base = user.photos();

    expect(base.collection("other")).not.toBe(base);
    expect(base.disk("public")).not.toBe(base);
    expect(base.accept({ mimes: [] })).not.toBe(base);
    expect(base.withModifiers([])).not.toBe(base);
  });

  it("carries configuration through a chain", async () => {
    const user = await makeUser();

    const media = (
      await user
        .photos()
        .disk("public")
        .rootPath("avatars")
        .withCustomProperties({ source: "test" })
        .add(bytes.PNG)
    ).first();

    expect(media?.disk).toBe("public");
    expect(media?.path.startsWith("avatars/")).toBe(true);
    expect(media?.getCustomProperty("source")).toBe("test");
    expect(media?.collection).toBe("photos");
  });
});

describe("accept narrowing", () => {
  it("cannot widen the app-wide floor", async () => {
    // An app that caps uploads has made a decision about its disk and
    // its bandwidth; a relation must not be able to opt out.
    const capped = await createHarness({ accept: { maxBytes: 10 } });
    const user = await makeUser();

    const error = await captureError(
      hasManyMedia(user).collection("photos").accept({ maxBytes: 10_000_000 }).add(bytes.PNG),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).constructor.name).toBe("MediaTooLargeError");

    await capped.cleanup();
  });

  it("intersects type lists with the floor", async () => {
    const restricted = await createHarness({ accept: { extensions: ["png", "jpg"] } });
    const user = await makeUser();

    // The relation asks for png+pdf; the app allows png+jpg. Only png
    // satisfies both.
    const relation = () =>
      hasManyMedia(user)
        .collection("photos")
        .accept({ extensions: ["png", "pdf"] });

    await expect(relation().add(bytes.PNG)).resolves.toBeDefined();
    await expect(relation().add(bytes.PDF)).rejects.toThrow(UnacceptableMediaTypeError);

    await restricted.cleanup();
  });
});

describe("modifiers through a builder", () => {
  it("applies the declared chain", async () => {
    const withImages = await createHarness({ image: { default: "fake" } });
    const user = await makeUser();

    const media = (
      await hasManyMedia(user)
        .collection("photos")
        .withModifiers([resizeDown(100), format("webp")])
        .add(bytes.PNG)
    ).first();

    expect(media?.extension).toBe("webp");
    expect(media?.image_width).toBe(100);

    await withImages.cleanup();
  });

  it("reports the resulting mime type before uploading", async () => {
    const user = await makeUser();

    const builder = hasManyMedia(user).withModifiers([format("webp")]);

    expect(builder.resultingMimeType("image/png")).toBe("image/webp");
  });
});
