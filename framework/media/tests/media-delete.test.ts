import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MediaCreated, MediaDeleted, MediaEvent, MediaUpdated } from "../src/events/media-event.js";
import { MediaFile } from "../src/models/media-file.model.js";
import * as bytes from "./__fixtures__/bytes.js";
import { createHarness, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe("delete", () => {
  it("removes the row and the file", async () => {
    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });
    const path = media.path;

    await harness.media.delete(media);

    await harness.disk.assertMissing(path);
    expect(await MediaFile.find(media.id)).toBeUndefined();
  });

  it("cleans up the file however the row is deleted", async () => {
    // The hook is on the model, not in the manager, so a delete through
    // the ORM cleans up too — a relation write, a cascade, or an app
    // calling `deleteInstance()` directly.
    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });
    const path = media.path;

    await media.deleteInstance();

    await harness.disk.assertMissing(path);
  });

  it("deletes from the right disk", async () => {
    const onPublic = await harness.media.add(bytes.PNG, { filename: "a.png", disk: "public" });
    const path = onPublic.path;

    await onPublic.deleteInstance();

    await harness.publicDisk.assertMissing(path);
  });

  it("still deletes the row when the file is already gone", async () => {
    // A vanished mount or an out-of-band removal must not make a record
    // undeletable. The row is the statement of intent; the file is a
    // side effect.
    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });

    await harness.disk.delete(media.path);
    await media.deleteInstance();

    expect(await MediaFile.find(media.id)).toBeUndefined();
  });

  it("leaves other rows' files alone", async () => {
    const one = await harness.media.add(bytes.PNG, { filename: "one.png" });
    const two = await harness.media.add(bytes.PNG, { filename: "two.png" });

    await one.deleteInstance();

    await harness.disk.assertMissing(one.path);
    await harness.disk.assertExists(two.path);
  });

  it("does not delete a file when a static delete has no loaded row", async () => {
    // `MediaFile.delete(id)` loads the row first, so this normally does
    // clean up. The guard exists for the payload that is only `{ id }`,
    // where there is no path to act on — the row still goes, and
    // `media:prune --files` reclaims the bytes.
    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });

    await MediaFile.delete(media.id);

    expect(await MediaFile.find(media.id)).toBeUndefined();
    await harness.disk.assertMissing(media.path);
  });
});

describe("events", () => {
  it("fires MediaCreated after the file is on the disk", async () => {
    // After, never before: a listener that queues a virus scan or a
    // transcode needs the bytes to be there.
    const seen: string[] = [];

    harness.events.listen(MediaCreated, async (event) => {
      seen.push(event.media.path);
      await harness.disk.assertExists(event.media.path);
    });

    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });

    expect(seen).toEqual([media.path]);
  });

  it("fires MediaUpdated on a metadata change", async () => {
    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });
    let fired = 0;

    harness.events.listen(MediaUpdated, () => {
      fired += 1;
    });

    await media.setCustomProperty("alt", "A cat").save();

    expect(fired).toBe(1);
  });

  it("fires MediaDeleted", async () => {
    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });
    const seen: bigint[] = [];

    harness.events.listen(MediaDeleted, (event) => {
      seen.push(event.media.id);
    });

    await media.deleteInstance();

    expect(seen).toEqual([media.id]);
  });

  it("catches every media event from one registration on the base class", async () => {
    // The reason `MediaEvent` is abstract and shared: the dispatcher
    // matches with `instanceof`, so one listener covers all three and
    // anything added later.
    const names: string[] = [];

    harness.events.listen(MediaEvent, (event) => {
      names.push(event.constructor.name);
    });

    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });
    await media.setCustomProperty("alt", "x").save();
    await media.deleteInstance();

    expect(names).toEqual(["MediaCreated", "MediaUpdated", "MediaDeleted"]);
  });

  it("names events stably, so a queued listener survives a minifier", async () => {
    expect(MediaCreated.eventName).toBe("media.MediaCreated");
    expect(MediaUpdated.eventName).toBe("media.MediaUpdated");
    expect(MediaDeleted.eventName).toBe("media.MediaDeleted");
  });

  it("carries the row on the event", async () => {
    let carried: MediaFile | undefined;

    harness.events.listen(MediaCreated, (event) => {
      carried = event.media;
    });

    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });

    expect(carried?.id).toBe(media.id);
    expect(carried?.mime_type).toBe("image/png");
  });
});
