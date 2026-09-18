import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Snowflake } from "../src/snowflake.js";

beforeEach(() => Snowflake.reset());
afterEach(() => Snowflake.reset());

describe("Snowflake", () => {
  it("generates a 64-bit integer", async () => {
    const id = await Snowflake.id();
    expect(typeof id).toBe("bigint");
    expect(String(id)).toMatch(/^\d{18,19}$/);
  });

  it("ids are unique and ordered", async () => {
    const all: bigint[] = [];

    for (let i = 0; i < 100; i++) {
      all.push(await Snowflake.id());
    }

    const unique = new Set(all);
    expect(unique.size).toBe(all.length);

    const sorted = [...all].sort((a, b) => (a < b ? -1 : 1));
    expect(sorted).toEqual(all);
  });

  it("can configure the relative epoch start date", async () => {
    const now = formatNow();
    await delay(2);

    Snowflake.configure(now, 1, 1);
    const recent = await Snowflake.id();
    expect(recent).toBeGreaterThan(100n);
    expect(recent).toBeLessThan(10_000_000_000n);

    const lastYear = formatShifted(-1);
    Snowflake.configure(lastYear, 2, 3);
    const id = await Snowflake.id();
    expect(String(id)).toMatch(/^\d{18}$/);

    const data = Snowflake.parse(id);
    expect(data.worker).toBe(3);
    expect(data.cluster).toBe(2);
    expect(data.datetime).toBe(now);
  });

  it("supports ids generated 30 years from epoch, and overflows at 36", async () => {
    const now = formatNow();

    for (const years of [10, 20, 30, 35]) {
      Snowflake.configure(formatShifted(-years), 1, 1);
      expect(String(await Snowflake.id())).toMatch(/^\d{19}$/);
    }

    Snowflake.configure(formatShifted(-35), 1, 1);
    const id = await Snowflake.id();
    expect(Snowflake.parse(id)).toMatchObject({
      worker: 1,
      cluster: 1,
      datetime: now,
    });

    Snowflake.configure(formatShifted(-36), 1, 1);
    expect(String(await Snowflake.id())).toMatch(/^-\d{19}$/);
  });

  it("parse round-trips cluster, worker, and sequence", async () => {
    Snowflake.configure("2025-01-01 00:00:00", 4, 7);
    const id = await Snowflake.id();
    const parsed = Snowflake.parse(id);
    expect(parsed.cluster).toBe(4);
    expect(parsed.worker).toBe(7);
    expect(parsed.sequence).toBeGreaterThanOrEqual(0);
    expect(parsed.sequence).toBeLessThanOrEqual(Snowflake.maxSequence());
  });
});

function formatNow(): string {
  return formatLocal(new Date());
}

function formatShifted(years: number): string {
  const date = new Date();
  date.setFullYear(date.getFullYear() + years);

  return formatLocal(date);
}

function formatLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
