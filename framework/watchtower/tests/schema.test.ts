import { afterEach, describe, expect, it } from "vitest";
import { DateTime } from "@mahiframework/datetime";
import { WatchtowerJobType } from "../src/models/watchtower-job-type.model.js";
import { WatchtowerJobRun } from "../src/models/watchtower-job-run.model.js";
import { createHarness, captureError, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

afterEach(() => {
  harness?.cleanup();
});

/**
 * The migrations and the models have to agree, and the only way to know
 * they do is to run the real migration files and then use the real
 * models against them.
 */
describe("watchtower schema", () => {
  it("creates the four tables", async () => {
    harness = await createHarness();

    const tables = (await harness.database
      .driver()
      .kysely.selectFrom("sqlite_master" as never)
      .select(["name" as never])
      .where("type" as never, "=", "table" as never)
      .execute()) as Array<{ name: string }>;

    const names = tables.map((row) => row.name);

    expect(names).toContain("watchtower_job_types");
    expect(names).toContain("watchtower_job_runs");
    expect(names).toContain("watchtower_jobs");
    expect(names).toContain("watchtower_failed_jobs");
  });

  it("assigns a uuidv7 key to a job type without a RETURNING round trip", async () => {
    harness = await createHarness();

    const now = DateTime.now();
    const type = await WatchtowerJobType.create({
      name: "app.jobs.sync-invoice",
      class_name: "SyncInvoiceJob",
      first_seen_at: now,
      last_seen_at: now,
    });

    // A v7 UUID: 36 chars, version nibble `7`.
    expect(type.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("orders job type keys by millisecond, but not within one", async () => {
    harness = await createHarness();

    const now = DateTime.now();
    const ids: string[] = [];

    // Enough that several land inside one millisecond on any machine.
    // A tighter loop would make the *grouping* below flaky without
    // making the point any better.
    for (let index = 0; index < 50; index += 1) {
      const type = await WatchtowerJobType.create({
        name: `app.jobs.job-${index}`,
        class_name: null,
        first_seen_at: now,
        last_seen_at: now,
      });
      ids.push(type.id);
    }

    // A v7 UUID leads with a 48-bit millisecond timestamp, so the
    // timestamp prefixes ascend with insert order.
    const prefixes = ids.map((id) => id.slice(0, 13));
    expect([...prefixes].sort()).toEqual(prefixes);

    // Within one millisecond the remaining bits are random, so insert
    // order and sort order diverge. This is the whole reason
    // `watchtower_jobs` keys on an auto-increment column instead: there
    // the key IS the FIFO tiebreak, and "ordered, except inside the
    // millisecond where all the contention is" is not a guarantee a
    // queue can make.
    const groups = new Map<string, string[]>();

    for (const [index, prefix] of prefixes.entries()) {
      groups.set(prefix, [...(groups.get(prefix) ?? []), ids[index]!]);
    }

    const contended = [...groups.values()].filter((group) => group.length > 1);
    expect(contended.length).toBeGreaterThan(0);

    const shuffled = contended.some((group) => [...group].sort().join() !== group.join());
    expect(shuffled).toBe(true);
  });

  it("rejects a duplicate job type name", async () => {
    harness = await createHarness();

    const now = DateTime.now();
    const attributes = {
      name: "app.jobs.sync-invoice",
      class_name: "SyncInvoiceJob",
      first_seen_at: now,
      last_seen_at: now,
    };

    await WatchtowerJobType.create(attributes);

    expect(await captureError(WatchtowerJobType.create(attributes))).toBeInstanceOf(Error);
  });

  it("rejects two runs claiming the same (dispatch_id, attempt)", async () => {
    harness = await createHarness();

    const type = await makeType();
    const dispatchId = "018f0000-0000-7000-8000-000000000001";

    await makeRun(type.id, dispatchId, 1);

    // The upsert key. Without this constraint the recorder's
    // out-of-order writes would silently produce duplicate rows for one
    // attempt rather than converging on it.
    expect(await captureError(makeRun(type.id, dispatchId, 1))).toBeInstanceOf(Error);
  });

  it("allows several attempts at one dispatch, and groups them", async () => {
    harness = await createHarness();

    const type = await makeType();
    const dispatchId = "018f0000-0000-7000-8000-000000000002";

    await makeRun(type.id, dispatchId, 1, "failed");
    await makeRun(type.id, dispatchId, 2, "failed");
    await makeRun(type.id, dispatchId, 3, "completed");

    const runs = await WatchtowerJobRun.forDispatch(dispatchId).get();

    expect(runs.map((run) => run.attempt).all()).toEqual([1, 2, 3]);
    expect(runs.map((run) => run.status).all()).toEqual(["failed", "failed", "completed"]);
  });

  it("cascades runs when their job type is deleted", async () => {
    harness = await createHarness();

    const type = await makeType();
    await makeRun(type.id, "018f0000-0000-7000-8000-000000000003", 1);

    await WatchtowerJobType.query().where("id", type.id).delete();

    expect(await WatchtowerJobRun.query().count()).toBe(0);
  });

  it("round-trips a stack trace through the error column", async () => {
    harness = await createHarness();

    const type = await makeType();
    const trace =
      "Error: Xero returned 429\n    at XeroClient.request (src/clients/xero.ts:142:19)";

    await makeRun(type.id, "018f0000-0000-7000-8000-000000000004", 1, "failed", trace);

    const run = await WatchtowerJobRun.query().first();

    // Newlines and leading indentation intact: the trace is only useful
    // if its shape survives, which is also why the dashboard renders it
    // inside a <pre>.
    expect(run?.error).toBe(trace);
  });

  it("keeps sub-second durations, which second-precision timestamps would lose", async () => {
    harness = await createHarness();

    const type = await makeType();
    await makeRun(type.id, "018f0000-0000-7000-8000-000000000005", 1, "completed", null, 212);

    const run = await WatchtowerJobRun.query().first();

    expect(run?.duration_ms).toBe(212);
  });

  it("gives watchtower_jobs a monotonic integer key, which FIFO depends on", async () => {
    harness = await createHarness();

    const ids: bigint[] = [];

    for (let index = 0; index < 5; index += 1) {
      const row = await harness.database
        .driver()
        .kysely.insertInto("watchtower_jobs" as never)
        .values({
          dispatch_id: `018f0000-0000-7000-8000-00000000001${index}`,
          queue: "default",
          priority: 0,
          job_class: "app.jobs.test",
          payload_json: "{}",
          chain_json: null,
          attempts: 0,
          deferrals: 0,
          available_at: "2026-01-01T00:00:00Z",
          reserved_at: null,
          reserved_by: null,
          created_at: "2026-01-01T00:00:00Z",
        } as never)
        .returning("id" as never)
        .executeTakeFirst();

      ids.push(BigInt((row as { id: number | bigint }).id));
    }

    // Strictly ascending. A burst dispatched inside one second ties on
    // `available_at`, so this key alone decides the order jobs run in.
    for (let index = 1; index < ids.length; index += 1) {
      expect(ids[index]! > ids[index - 1]!).toBe(true);
    }
  });

  it("defaults a pending job's counters and reservation to empty", async () => {
    harness = await createHarness();

    await harness.database
      .driver()
      .kysely.insertInto("watchtower_jobs" as never)
      .values({
        dispatch_id: "018f0000-0000-7000-8000-000000000020",
        job_class: "app.jobs.test",
        payload_json: "{}",
        available_at: "2026-01-01T00:00:00Z",
        created_at: "2026-01-01T00:00:00Z",
      } as never)
      .execute();

    const row = (await harness.database
      .driver()
      .kysely.selectFrom("watchtower_jobs" as never)
      .selectAll()
      .executeTakeFirst()) as {
      queue: string;
      priority: number;
      attempts: number;
      deferrals: number;
      reserved_at: string | null;
      reserved_by: string | null;
    };

    expect(row.queue).toBe("default");
    expect(row.priority).toBe(0);
    expect(row.attempts).toBe(0);
    // Separate from `attempts` on purpose: a cooldown must not consume
    // an attempt, or a throttled job fails without ever having failed.
    expect(row.deferrals).toBe(0);
    expect(row.reserved_at).toBeNull();
    expect(row.reserved_by).toBeNull();
  });
});

async function makeType(name = "app.jobs.sync-invoice"): Promise<WatchtowerJobType> {
  const now = DateTime.now();

  return (await WatchtowerJobType.create({
    name,
    class_name: "SyncInvoiceJob",
    first_seen_at: now,
    last_seen_at: now,
  })) as WatchtowerJobType;
}

async function makeRun(
  typeId: string,
  dispatchId: string,
  attempt: number,
  status: "pending" | "running" | "completed" | "failed" | "released" = "running",
  error: string | null = null,
  durationMs: number | null = null,
): Promise<WatchtowerJobRun> {
  const now = DateTime.now();

  return (await WatchtowerJobRun.create({
    watchtower_job_type_id: typeId,
    dispatch_id: dispatchId,
    invocation_id: null,
    process: "default",
    queue: "default",
    worker_run_id: null,
    status,
    attempt,
    queued_at: now,
    started_at: now,
    finished_at: status === "running" ? null : now,
    duration_ms: durationMs,
    error,
  })) as WatchtowerJobRun;
}
