import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATABASE_TOKEN, type DatabaseManager } from "@mahiframework/database";
import { Activity } from "../src/activity-facade.js";
import { createHarness, Post, Widget, type Harness } from "./__fixtures__/test-app.js";

/** Make the next activity write fail for a reason the package cannot control. */
async function dropActivityLogs(harness: Harness): Promise<void> {
  const database = harness.app.make<DatabaseManager>(DATABASE_TOKEN);
  await database.driver().kysely.schema.dropTable("activity_logs").execute();
}

describe("resource listener", () => {
  let harness: Harness;

  afterEach(() => harness.cleanup());

  async function makePost(overrides: Partial<Post> = {}): Promise<Post> {
    return Post.create({
      id: "post-1",
      title: "First",
      body: "Body",
      secret_note: "classified",
      settings: null,
      deleted_at: null,
      ...overrides,
    });
  }

  describe("when the model is configured", () => {
    beforeEach(async () => {
      harness = await createHarness({ resources: { Post: "full" } });
    });

    it("records a create with its attributes, masking the hidden column", async () => {
      await makePost();

      const rows = await harness.rows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: "resource",
        action: "created",
        model_type: "Post",
        model_id: "post-1",
      });
      // `getChanges()` is empty after an insert, so the create path has to
      // read attributes instead. A row with an empty payload would mean
      // the listener read the wrong window.
      const attributes = (rows[0]!.data as { attributes: Record<string, unknown> }).attributes;
      expect(attributes["title"]).toBe("First");
      expect(attributes["secret_note"]).toBe("[masked]");
    });

    it("records an update as a from/to pair", async () => {
      const post = await makePost();
      post.title = "Second";
      await post.save();

      const rows = await harness.rows();
      expect(rows).toHaveLength(2);
      // Proves the listener reads inside the open dirty window: after
      // `syncOriginal()` runs, `from` would be the new value too.
      expect(rows[1]).toMatchObject({ action: "updated" });
      expect(rows[1]!.data).toEqual({ changes: { title: { from: "First", to: "Second" } } });
    });

    it("records a soft delete as soft_deleted", async () => {
      const post = await makePost();
      await post.deleteInstance();

      const rows = await harness.rows();
      expect(rows[1]).toMatchObject({ action: "soft_deleted" });
    });

    it("records a restore", async () => {
      const post = await makePost();
      await post.deleteInstance();
      await post.restore();

      const rows = await harness.rows();
      expect(rows[2]).toMatchObject({ action: "restored" });
    });

    it("degrades Model.update(id, values) to column names", async () => {
      await makePost();
      await Post.update("post-1", { title: "Third" });

      const rows = await harness.rows();
      // That static fires `updated` with a plain object, so there is no
      // from-value to read. Column names regardless of the "full" mode.
      expect(rows[1]).toMatchObject({ action: "updated" });
      expect(rows[1]!.data).toEqual({ changed: ["title"], partial: true });
    });

    it("writes nothing for a builder-level bulk update", async () => {
      await makePost();
      const before = (await harness.rows()).length;

      await Post.query().where("id", "post-1").update({ title: "Bulk" });

      // `EloquentBuilder.update()` fires no model events at all. This is
      // the boundary of what the package can see, and a test pins it so
      // the limitation is deliberate rather than a surprise.
      expect(await harness.rows()).toHaveLength(before);
    });

    it("writes nothing inside Model.withoutEvents()", async () => {
      await Post.withoutEvents(() => makePost());

      // Which is also why factories and seeders do not pollute the log.
      expect(await harness.rows()).toEqual([]);
    });

    it("writes nothing inside Activity.without()", async () => {
      await Activity.without(() => makePost());

      expect(await harness.rows()).toEqual([]);
    });

    it("still logs after a suppressed scope ends", async () => {
      await Activity.without(() => makePost());
      await makePost({ id: "post-2" });

      const rows = await harness.rows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.model_id).toBe("post-2");
    });
  });

  describe("capture modes", () => {
    it("writes a row with no data in none mode", async () => {
      harness = await createHarness({ resources: { Post: "none" } });
      await makePost();

      const rows = await harness.rows();
      // A row, but no payload: the event happened, what changed is not
      // recorded. Not the same as omitting the model.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.data).toBeNull();
    });

    it("writes names without values in columns mode", async () => {
      harness = await createHarness({ resources: { Post: "columns" } });
      await makePost();

      const rows = await harness.rows();
      expect(rows[0]!.data).toMatchObject({ attributes: expect.arrayContaining(["title"]) });
      expect(JSON.stringify(rows[0]!.data)).not.toContain("classified");
    });

    it("honours a per-model mask", async () => {
      harness = await createHarness({ resources: { Post: { capture: "full", mask: ["body"] } } });
      await makePost();

      const rows = await harness.rows();
      const attributes = (rows[0]!.data as { attributes: Record<string, unknown> }).attributes;
      expect(attributes["body"]).toBe("[masked]");
    });

    it("honours except", async () => {
      harness = await createHarness({
        resources: { Post: { capture: "columns", except: ["body"] } },
      });
      await makePost();

      const rows = await harness.rows();
      const names = (rows[0]!.data as { attributes: string[] }).attributes;
      expect(names).not.toContain("body");
      expect(names).toContain("title");
    });

    it("honours only", async () => {
      harness = await createHarness({
        resources: { Post: { capture: "columns", only: ["title"] } },
      });
      await makePost();

      const rows = await harness.rows();
      expect((rows[0]!.data as { attributes: string[] }).attributes).toEqual(["title"]);
    });

    it("honours an actions filter", async () => {
      harness = await createHarness({
        resources: { Post: { capture: "columns", actions: ["updated"] } },
      });
      const post = await makePost();
      post.title = "Changed";
      await post.save();

      const rows = await harness.rows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe("updated");
    });
  });

  describe("delete semantics", () => {
    it("records a hard delete as deleted on a model without soft deletes", async () => {
      harness = await createHarness({ resources: { Widget: "columns" } });
      const widget = await Widget.create({ id: "w-1", name: "Gear", internal: "x" });
      await widget.deleteInstance();

      const rows = await harness.rows();
      expect(rows[1]).toMatchObject({ action: "deleted", model_type: "Widget" });
    });
  });

  describe("when the model is not configured", () => {
    beforeEach(async () => {
      harness = await createHarness({ resources: {} });
    });

    it("writes nothing at all", async () => {
      await makePost();

      expect(await harness.rows()).toEqual([]);
    });
  });

  describe("safety", () => {
    it("never logs a write to its own table, even when configured to", async () => {
      // A hard guard, not a convention: the config is a string map and
      // nothing stops someone typing this. Without it the first mutation
      // would recurse until the stack blew.
      harness = await createHarness({
        resources: { Post: "columns", ActivityLog: "full" },
      });

      await makePost();

      const rows = await harness.rows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.model_type).toBe("Post");
    });

    it("does not fail the save when the log write throws", async () => {
      harness = await createHarness({ resources: { Post: "full" } });

      // Drop the table from under the listener: the next write fails for
      // a reason the package cannot control, which is the scenario the
      // isolation exists for.
      await dropActivityLogs(harness);

      // The business operation must still succeed. An audit row matters;
      // it does not matter more than the thing it audits.
      await expect(makePost()).resolves.toBeDefined();
      expect(await Post.find("post-1")).toBeDefined();
    });

    it("fails the save when throwOnFailure is set", async () => {
      harness = await createHarness({ resources: { Post: "full" }, throwOnFailure: true });

      await dropActivityLogs(harness);

      await expect(makePost()).rejects.toThrow();
    });
  });
});
