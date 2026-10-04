import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "@mahiframework/datetime";
import { ActivityLogsPruneCommand } from "../src/commands/activity-logs-prune.js";
import { ActivityLog } from "../src/models/activity-log.model.js";
import { createHarness, type Harness } from "./__fixtures__/test-app.js";

describe("activity-logs:prune", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(() => harness.cleanup());

  async function seed(daysAgo: number, type = "resource"): Promise<void> {
    await ActivityLog.create({
      id: randomUUID(),
      type,
      action: "created",
      model_type: "Post",
      model_id: "p-1",
      user_id: null,
      message: null,
      data: null,
      created_at: DateTime.now().subDays(daysAgo),
    });
  }

  function command(): ActivityLogsPruneCommand {
    return new ActivityLogsPruneCommand(harness.app);
  }

  it("deletes only rows older than the window", async () => {
    await seed(120);
    await seed(10);

    await command().handle({ days: "90" });

    const remaining = await ActivityLog.query().get();
    expect(remaining.all()).toHaveLength(1);
  });

  it("deletes nothing on a dry run", async () => {
    await seed(120);

    await command().handle({ days: "90", dryRun: true });

    expect(await ActivityLog.query().count()).toBe(1);
  });

  it("scopes to one type when asked", async () => {
    await seed(120, "resource");
    await seed(120, "security");

    await command().handle({ days: "90", type: "resource" });

    const remaining = (await ActivityLog.query().get()).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.type).toBe("security");
  });

  it("stops at the limit rather than deleting everything in one statement", async () => {
    // The first prune on a never-pruned table can match millions of rows,
    // and one unbounded DELETE holds a long transaction and a lot of
    // locks. Running it twice is cheap.
    await seed(120);
    await seed(121);
    await seed(122);

    await command().handle({ days: "90", limit: "2" });

    expect(await ActivityLog.query().count()).toBe(1);
  });

  it("refuses a negative window instead of deleting the future", async () => {
    await seed(1);

    await command().handle({ days: "-10" });

    expect(await ActivityLog.query().count()).toBe(1);
  });
});
