import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Relation } from "@mahiframework/database";
import { MediaCheckCommand } from "../src/commands/media-check.js";
import { MediaPruneCommand } from "../src/commands/media-prune.js";
import { MediaFile } from "../src/models/media-file.model.js";
import * as bytes from "./__fixtures__/bytes.js";
import { createHarness, makeUser, Tenant, User, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
  // The commands resolve owners through the morph map, so the test app
  // has to register the same aliases a real app's providers would.
  Relation.morphMap({ User: () => User as never, Tenant: () => Tenant as never });
});

afterEach(async () => {
  await harness.cleanup();
  process.exitCode = undefined;
});

/** Capture the logger, so output is assertable and not printed. */
function captureLogs() {
  const info = vi.spyOn(harness.app.logger, "info").mockImplementation(() => {});
  const error = vi.spyOn(harness.app.logger, "error").mockImplementation(() => {});

  return {
    info: () => info.mock.calls.map((call) => String(call[0])).join("\n"),
    error: () => error.mock.calls.map((call) => String(call[0])).join("\n"),
    restore: () => {
      info.mockRestore();
      error.mockRestore();
    },
  };
}

describe("media:prune", () => {
  it("deletes rows whose owner is gone, and their files", async () => {
    // Nothing cascades into this table — `media.model_id` carries no
    // foreign key, because it holds the key of any model and the app
    // owns those tables. This command is the other half of that trade.
    const user = await makeUser();
    const media = (await user.photos().add(bytes.PNG)).first();

    await User.delete(user.id);

    const logs = captureLogs();

    try {
      await new MediaPruneCommand(harness.app).handle();
    } finally {
      logs.restore();
    }

    expect(await MediaFile.find(media?.id as bigint)).toBeUndefined();
    await harness.disk.assertMissing(media?.path ?? "");
  });

  it("leaves rows whose owner still exists", async () => {
    const user = await makeUser();

    await user.photos().add(bytes.PNG);

    const logs = captureLogs();

    try {
      await new MediaPruneCommand(harness.app).handle();
    } finally {
      logs.restore();
    }

    expect((await user.photos().get()).all()).toHaveLength(1);
  });

  it("leaves ownerless rows alone", async () => {
    // A `belongsToMedia` row records no owner, because the owner holds
    // the reference. Treating "no owner recorded" as "owner gone" would
    // delete every avatar in the application.
    const user = await makeUser();
    const avatar = await user.avatar().set(bytes.PNG);

    const logs = captureLogs();

    try {
      await new MediaPruneCommand(harness.app).handle();
    } finally {
      logs.restore();
    }

    expect(await MediaFile.find(avatar.id)).toBeDefined();
  });

  it("reports without deleting under --dry-run", async () => {
    const user = await makeUser();
    const media = (await user.photos().add(bytes.PNG)).first();

    await User.delete(user.id);

    const logs = captureLogs();

    try {
      await new MediaPruneCommand(harness.app).handle({ dryRun: true });

      expect(logs.info()).toContain("would delete 1 orphaned row");
    } finally {
      logs.restore();
    }

    expect(await MediaFile.find(media?.id as bigint)).toBeDefined();
  });

  it("skips a model_type it cannot resolve, rather than deleting it", async () => {
    // The morph map is populated by providers, so a command that loaded
    // fewer of them than the app does would otherwise delete every row
    // belonging to a model it simply could not see.
    const user = await makeUser();
    const media = (await user.photos().add(bytes.PNG)).first();

    await MediaFile.query()
      .whereKey(media?.id as bigint)
      .update({ model_type: "Ghost" });

    const logs = captureLogs();

    try {
      await new MediaPruneCommand(harness.app).handle();

      expect(logs.info()).toContain('skipped "Ghost"');
    } finally {
      logs.restore();
    }

    expect(await MediaFile.find(media?.id as bigint)).toBeDefined();
  });

  it("respects the limit", async () => {
    const user = await makeUser();

    await user.photos().add([bytes.PNG, bytes.JPEG, bytes.GIF]);
    await User.delete(user.id);

    const logs = captureLogs();

    try {
      await new MediaPruneCommand(harness.app).handle({ limit: "2" });
    } finally {
      logs.restore();
    }

    expect((await MediaFile.query().get()).all()).toHaveLength(1);
  });

  it("rejects a non-positive limit", async () => {
    const logs = captureLogs();

    try {
      await new MediaPruneCommand(harness.app).handle({ limit: "0" });

      expect(logs.error()).toContain("positive --limit");
    } finally {
      logs.restore();
    }

    expect(process.exitCode).toBe(1);
  });

  it("sweeps orphaned files under --files", async () => {
    // A file with no row: the upload path writes the file before
    // inserting the row, deliberately, so this is the recoverable half
    // of that trade.
    await harness.disk.put("8c19165c/9b72/4d57/90ae/orphan.png", Buffer.from(bytes.PNG));

    const logs = captureLogs();

    try {
      await new MediaPruneCommand(harness.app).handle({ files: true });
    } finally {
      logs.restore();
    }

    await harness.disk.assertMissing("8c19165c/9b72/4d57/90ae/orphan.png");
  });

  it("does not sweep files that rows point at", async () => {
    const user = await makeUser();
    const media = (await user.photos().add(bytes.PNG)).first();

    const logs = captureLogs();

    try {
      await new MediaPruneCommand(harness.app).handle({ files: true });
    } finally {
      logs.restore();
    }

    await harness.disk.assertExists(media?.path ?? "");
  });

  it("does not sweep files at all without --files", async () => {
    // Listing a whole disk is a paid API call per thousand keys on an
    // object store, so it has to be asked for.
    await harness.disk.put("stray.png", Buffer.from(bytes.PNG));

    const logs = captureLogs();

    try {
      await new MediaPruneCommand(harness.app).handle();
    } finally {
      logs.restore();
    }

    await harness.disk.assertExists("stray.png");
  });

  it("reports an empty run cleanly", async () => {
    const logs = captureLogs();

    try {
      await new MediaPruneCommand(harness.app).handle();

      expect(logs.info()).toContain("no orphaned rows");
    } finally {
      logs.restore();
    }

    expect(process.exitCode).toBeUndefined();
  });
});

describe("media:check", () => {
  it("passes for a clean install with no rows", async () => {
    const logs = captureLogs();

    try {
      await new MediaCheckCommand(harness.app).handle();
    } finally {
      logs.restore();
    }

    expect(process.exitCode).toBeUndefined();
  });

  it("passes when every file is present", async () => {
    const user = await makeUser();

    await user.photos().add([bytes.PNG, bytes.PDF]);

    const logs = captureLogs();

    try {
      await new MediaCheckCommand(harness.app).handle();

      expect(logs.info()).toContain("2 row(s) checked");
    } finally {
      logs.restore();
    }

    expect(process.exitCode).toBeUndefined();
  });

  it("fails on a missing file", async () => {
    const user = await makeUser();
    const media = (await user.photos().add(bytes.PNG)).first();

    await harness.disk.delete(media?.path ?? "");

    const logs = captureLogs();

    try {
      await new MediaCheckCommand(harness.app).handle();

      expect(logs.error()).toContain("is missing");
    } finally {
      logs.restore();
    }

    expect(process.exitCode).toBe(1);
  });

  it("fails on an unresolvable model_type", async () => {
    // `morphAlias()` falls back to the table name, so renaming a table
    // orphans every row naming the old one — and media rows outlive
    // table renames.
    const user = await makeUser();
    const media = (await user.photos().add(bytes.PNG)).first();

    await MediaFile.query()
      .whereKey(media?.id as bigint)
      .update({ model_type: "RenamedAwayModel" });

    const logs = captureLogs();

    try {
      await new MediaCheckCommand(harness.app).handle();

      expect(logs.error()).toContain("RenamedAwayModel");
    } finally {
      logs.restore();
    }

    expect(process.exitCode).toBe(1);
  });

  it("detects a file changed out of band under --verify", async () => {
    const user = await makeUser();
    const media = (await user.photos().add(bytes.PNG)).first();

    await harness.disk.put(media?.path ?? "", Buffer.from("replaced"));

    const logs = captureLogs();

    try {
      await new MediaCheckCommand(harness.app).handle({ verify: true });

      expect(logs.error()).toContain("does not match its recorded checksum");
    } finally {
      logs.restore();
    }

    expect(process.exitCode).toBe(1);
  });

  it("does not hash anything without --verify", async () => {
    // Verification reads every byte of every file, which is why it is
    // opt-in.
    const user = await makeUser();
    const media = (await user.photos().add(bytes.PNG)).first();

    await harness.disk.put(media?.path ?? "", Buffer.from("replaced"));

    const logs = captureLogs();

    try {
      await new MediaCheckCommand(harness.app).handle();
    } finally {
      logs.restore();
    }

    expect(process.exitCode).toBeUndefined();
  });

  it("ignores ownerless rows when checking owners", async () => {
    const user = await makeUser();

    await user.avatar().set(bytes.PNG);

    const logs = captureLogs();

    try {
      await new MediaCheckCommand(harness.app).handle();
    } finally {
      logs.restore();
    }

    expect(process.exitCode).toBeUndefined();
  });

  it("rejects a non-positive limit", async () => {
    const logs = captureLogs();

    try {
      await new MediaCheckCommand(harness.app).handle({ limit: "-1" });

      expect(logs.error()).toContain("positive --limit");
    } finally {
      logs.restore();
    }

    expect(process.exitCode).toBe(1);
  });
});

describe("the provider registers both commands", () => {
  it("lists them in commands()", () => {
    expect(harness.provider.commands()).toEqual([MediaPruneCommand, MediaCheckCommand]);
  });
});
