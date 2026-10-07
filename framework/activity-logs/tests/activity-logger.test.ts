import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWithAuth } from "@mahiframework/auth";
import { Activity } from "../src/activity-facade.js";
import { ActivityLog } from "../src/models/activity-log.model.js";
import { createHarness, Post, type Harness } from "./__fixtures__/test-app.js";

describe("Activity.log", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({ mask: ["api_key"] });
  });

  afterEach(() => harness.cleanup());

  it("records an application-defined type against a model instance", async () => {
    const post = await Post.create({
      id: "p-1",
      title: "T",
      body: "B",
      secret_note: null,
      settings: null,
      deleted_at: null,
    });

    await Activity.log({
      type: "billing",
      action: "invoice_sent",
      model: post,
      message: "Invoice sent",
      data: { amount: 1200 },
    });

    const rows = await harness.rows();
    expect(rows[0]).toMatchObject({
      type: "billing",
      action: "invoice_sent",
      model_type: "Post",
      model_id: "p-1",
      message: "Invoice sent",
    });
    expect(rows[0]!.data).toMatchObject({ amount: 1200 });
  });

  it("accepts an explicit subject with no instance in hand", async () => {
    await Activity.log({
      type: "integration",
      action: "sync_failed",
      modelType: "Source",
      modelId: 42,
    });

    expect((await harness.rows())[0]).toMatchObject({
      model_type: "Source",
      model_id: "42",
    });
  });

  it("masks a developer-supplied payload", async () => {
    // The path where a token gets logged by accident, so the global mask
    // applies here too rather than only to model capture.
    await Activity.log({
      type: "integration",
      modelType: "Source",
      modelId: "s-1",
      data: { credentials: { api_key: "live_abc" } },
    });

    expect(JSON.stringify((await harness.rows())[0]!.data)).not.toContain("live_abc");
  });

  it("truncates an over-long message", async () => {
    await Activity.log({
      type: "note",
      modelType: "Source",
      modelId: "s-1",
      message: "x".repeat(400),
    });

    expect((await harness.rows())[0]!.message).toHaveLength(255);
  });

  it("writes nothing and returns null without a subject", async () => {
    // There is deliberately no subjectless row: a nullable subject would
    // make every read query branch.
    await expect(Activity.log({ type: "note" })).resolves.toBeNull();
    expect(await harness.rows()).toEqual([]);
  });

  it("defaults the actor to the ambient user", async () => {
    await runWithAuth({ user: { id: "u-7" }, guard: "web" }, async () => {
      await Activity.log({ type: "note", modelType: "Source", modelId: "s-1" });
    });

    expect((await harness.rows())[0]!.user_id).toBe("u-7");
  });

  it("treats an explicit null user as deliberately unattributed", async () => {
    // Distinct from omitting it, which means "whoever is ambient".
    await runWithAuth({ user: { id: "u-7" }, guard: "web" }, async () => {
      await Activity.log({ type: "note", modelType: "Source", modelId: "s-1", user: null });
    });

    expect((await harness.rows())[0]!.user_id).toBeNull();
  });

  it("accepts a bigint actor, which an auto-increment key is", async () => {
    await Activity.log({
      type: "note",
      modelType: "Source",
      modelId: "s-1",
      user: 9007199254740993n,
    });

    expect((await harness.rows())[0]!.user_id).toBe("9007199254740993");
  });

  it("returns null when disabled, so a caller can tell skipped from written", async () => {
    harness.cleanup();
    harness = await createHarness({ enabled: false });

    await expect(
      Activity.log({ type: "note", modelType: "Source", modelId: "s-1" }),
    ).resolves.toBeNull();
  });

  it("pins the type through resource() and security()", async () => {
    // Not shorthand for less typing: these stop an app landing a row in
    // the wrong bucket by spelling the string differently.
    await Activity.resource("archived", { modelType: "Post", modelId: "p-1" });
    await Activity.security("suspicious", { modelType: "User", modelId: "u-1" });

    expect((await harness.rows()).map((row) => row.type)).toEqual(["resource", "security"]);
  });
});

describe("context", () => {
  let harness: Harness;

  afterEach(() => harness.cleanup());

  it("merges a context thunk under data.context", async () => {
    harness = await createHarness({
      context: () => ({ ip: "203.0.113.7", request_id: "req-1" }),
    });

    await Activity.log({ type: "note", modelType: "Source", modelId: "s-1", data: { a: 1 } });

    expect((await harness.rows())[0]!.data).toEqual({
      a: 1,
      context: { ip: "203.0.113.7", request_id: "req-1" },
    });
  });

  it("omits the key entirely when the thunk returns nothing", async () => {
    harness = await createHarness({ context: () => undefined });

    await Activity.log({ type: "note", modelType: "Source", modelId: "s-1" });

    expect((await harness.rows())[0]!.data).toBeNull();
  });

  it("survives a throwing thunk rather than losing the row", async () => {
    // Context is enrichment. A row with no IP beats no row at all.
    harness = await createHarness({
      context: () => {
        throw new Error("context exploded");
      },
    });

    await expect(
      Activity.log({ type: "note", modelType: "Source", modelId: "s-1" }),
    ).resolves.not.toBeNull();
  });
});

describe("read helpers", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(() => harness.cleanup());

  it("scopes by subject, by actor and by type", async () => {
    await Activity.log({ type: "a", modelType: "Post", modelId: "p-1", user: "u-1" });
    await Activity.log({ type: "b", modelType: "Post", modelId: "p-2", user: "u-1" });
    await Activity.log({ type: "a", modelType: "Widget", modelId: "w-1", user: "u-2" });

    expect(await ActivityLog.for("Post", "p-1").count()).toBe(1);
    expect(await ActivityLog.by("u-1").count()).toBe(2);
    expect(await ActivityLog.ofType("a").count()).toBe(2);
  });

  it("accepts a non-string key, stringifying it the way the row stores it", async () => {
    await Activity.log({ type: "a", modelType: "Post", modelId: 7 });

    expect(await ActivityLog.for("Post", 7).count()).toBe(1);
  });
});
