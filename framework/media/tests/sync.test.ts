import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MediaFile } from "../src/models/media-file.model.js";
import * as bytes from "./__fixtures__/bytes.js";
import { createHarness, makeUser, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

/** A user with three photos, for the reorder scenarios. */
async function seeded() {
  const user = await makeUser();
  const added = await user.photos().add([bytes.PNG, bytes.JPEG, bytes.GIF]);

  return { user, ids: added.all().map((row) => row.id) };
}

describe("sync", () => {
  // The five scenarios laravel-media's own suite covers, plus the
  // transaction behaviour its version lacks.

  it("is a no-op when the payload matches", async () => {
    const { user, ids } = await seeded();

    const result = await user.photos().sync(ids);

    expect(result.all().map((row) => row.id)).toEqual(ids);
    expect(result.all().map((row) => row.order)).toEqual([1, 2, 3]);
  });

  it("deletes rows absent from the payload", async () => {
    const { user, ids } = await seeded();
    const [first, , third] = ids;

    const removed = await MediaFile.findOrFail(ids[1] as bigint);

    await user.photos().sync([first as bigint, third as bigint]);

    expect((await user.photos().get()).all().map((row) => row.id)).toEqual([first, third]);
    expect(await MediaFile.find(removed.id)).toBeUndefined();
    await harness.disk.assertMissing(removed.path);
  });

  it("reorders without touching the files", async () => {
    const { user, ids } = await seeded();
    const [first, second, third] = ids;

    const result = await user.photos().sync([third as bigint, first as bigint, second as bigint]);

    expect(result.all().map((row) => row.id)).toEqual([third, first, second]);
    expect(result.all().map((row) => row.order)).toEqual([1, 2, 3]);

    // Still three files on the disk.
    expect(await harness.disk.allFiles()).toHaveLength(3);
  });

  it("appends a new file", async () => {
    const { user, ids } = await seeded();

    const result = await user.photos().sync([...ids, bytes.PDF]);

    expect(result.all()).toHaveLength(4);
    expect(result.all()[3]?.mime_type).toBe("application/pdf");
    expect(result.all()[3]?.order).toBe(4);
  });

  it("inserts a new file in the middle", async () => {
    // The scenario the mixed-array design exists for: one ordered
    // payload carrying both "keep this" and "here is a new one".
    const { user, ids } = await seeded();
    const [first, second, third] = ids;

    const result = await user
      .photos()
      .sync([first as bigint, bytes.PDF, second as bigint, third as bigint]);

    expect(result.all().map((row) => row.order)).toEqual([1, 2, 3, 4]);
    expect(result.all()[1]?.mime_type).toBe("application/pdf");
    expect(result.all().map((row) => row.id)).toEqual([first, result.all()[1]?.id, second, third]);
  });

  it("empties the collection when given nothing", async () => {
    const { user } = await seeded();

    const result = await user.photos().sync([]);

    expect(result.all()).toHaveLength(0);
    expect((await user.photos().get()).all()).toHaveLength(0);
    expect(await harness.disk.allFiles()).toHaveLength(0);
  });

  it("stamps the owner and collection on new files", async () => {
    const { user } = await seeded();

    const result = await user.photos().sync([bytes.PDF]);

    expect(result.all()[0]?.model_type).toBe("User");
    expect(result.all()[0]?.model_id).toBe(String(user.id));
    expect(result.all()[0]?.collection).toBe("photos");
  });

  it("accepts string ids, as a form would submit them", async () => {
    const { user, ids } = await seeded();

    const result = await user.photos().sync(ids.map((id) => String(id)));

    expect(result.all().map((row) => row.id)).toEqual(ids);
  });

  it("ignores an id this collection does not hold", async () => {
    // The common cause is a stale form posting an id someone else
    // deleted. Failing the whole sync over it would lose the user's
    // other edits.
    const { user, ids } = await seeded();

    const result = await user.photos().sync([ids[0] as bigint, "999999999999999999"]);

    expect(result.all()).toHaveLength(1);
    expect(result.all()[0]?.id).toBe(ids[0]);
  });

  it("does not steal another collection's row by id", async () => {
    const { user } = await seeded();
    const doc = (await user.documents().add(bytes.PDF)).first();

    const result = await user.photos().sync([doc?.id as bigint]);

    // The id is not in `photos`, so it is ignored rather than moved.
    expect(result.all()).toHaveLength(0);
    expect((await user.documents().get()).all()).toHaveLength(1);
  });

  it("leaves another owner's collection untouched", async () => {
    const { user } = await seeded();
    const other = await makeUser();

    await other.photos().add(bytes.PNG);
    await user.photos().sync([]);

    expect((await other.photos().get()).all()).toHaveLength(1);
  });

  it("does not delete anything when the transaction rolls back", async () => {
    // The guarantee laravel-media's version lacks: its sync is not
    // transactional, so a failure part-way through leaves duplicate and
    // missing order values AND files deleted for rows that came back.
    //
    // The payload DROPS the first row, so there is genuinely something
    // to delete — a payload keeping every row would make this pass
    // whatever the implementation did.
    const { user, ids } = await seeded();
    const doomed = await MediaFile.findOrFail(ids[0] as bigint);

    // Fail on the FIRST renumbering save. `sync()` only saves rows whose
    // order actually changed, so keying the failure on a call count
    // would depend on how many that happens to be — and with this
    // payload it is one, which is how an earlier version of this test
    // passed without the implementation being correct.
    const original = MediaFile.prototype.save;

    MediaFile.prototype.save = async function patched(this: MediaFile) {
      throw new Error("write failed");
    } as typeof MediaFile.prototype.save;

    try {
      await expect(user.photos().sync([ids[2] as bigint, ids[1] as bigint])).rejects.toThrow(
        "write failed",
      );
    } finally {
      MediaFile.prototype.save = original;
    }

    // The dropped row is still there, with its bytes: the row delete was
    // rolled back and the file delete never ran, because it is deferred
    // until after the commit.
    expect(await MediaFile.find(doomed.id)).toBeDefined();
    await harness.disk.assertExists(doomed.path);
    expect((await user.photos().get()).all()).toHaveLength(3);

    // And the renumbering did not partially apply.
    expect((await user.photos().get()).all().map((row) => row.order)).toEqual([1, 2, 3]);
  });
});

describe("syncFromRequest", () => {
  // The shape an HTML form submits: an ordered list of ids with empty
  // slots where new files go, plus the files themselves.

  it("merges ids and uploads by position", async () => {
    const { user, ids } = await seeded();

    const result = await user.photos().syncFromRequest(
      {
        input: () => [String(ids[0]), "", String(ids[2])],
        files: () => [bytes.PDF],
      },
      "photos",
    );

    expect(result.all()).toHaveLength(3);
    expect(result.all()[1]?.mime_type).toBe("application/pdf");
    expect(result.all().map((row) => row.order)).toEqual([1, 2, 3]);
  });

  it("appends files beyond the id list", async () => {
    const { user, ids } = await seeded();

    const result = await user.photos().syncFromRequest(
      {
        input: () => [String(ids[0])],
        files: () => [bytes.PDF, bytes.JPEG],
      },
      "photos",
    );

    expect(result.all()).toHaveLength(3);
    expect(result.all().map((row) => row.mime_type)).toEqual([
      "image/png",
      "application/pdf",
      "image/jpeg",
    ]);
  });

  it("handles a request with only uploads", async () => {
    const user = await makeUser();

    const result = await user
      .photos()
      .syncFromRequest({ input: () => undefined, files: () => [bytes.PNG] }, "photos");

    expect(result.all()).toHaveLength(1);
  });

  it("empties the collection for an empty request", async () => {
    const { user } = await seeded();

    const result = await user
      .photos()
      .syncFromRequest({ input: () => [], files: () => [] }, "photos");

    expect(result.all()).toHaveLength(0);
  });
});
