import { afterEach, describe, expect, it, vi } from "vitest";
import { monotonicUuid } from "../src/monotonic-id.js";

/**
 * These ids are the queue's tiebreak when `available_at` cannot separate
 * two jobs, so "sorts by push order as a string" is not a nicety here —
 * it is the whole reason the generator exists.
 */
describe("monotonicUuid", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a well-formed UUIDv7", () => {
    const id = monotonicUuid();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("sorts lexicographically in the order it was generated", () => {
    const ids = Array.from({ length: 2_000 }, () => monotonicUuid());

    expect([...ids].sort()).toEqual(ids);
  });

  /**
   * The case that actually broke publishing: a fan-out loop mints every
   * id inside one tick, so the timestamp is identical across all of them
   * and only the counter can order them.
   */
  it("stays ordered within a single millisecond", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const ids = Array.from({ length: 500 }, () => monotonicUuid());

    expect(new Set(ids).size).toBe(500);
    expect([...ids].sort()).toEqual(ids);
  });

  /**
   * Imported fresh: the generator holds the last timestamp it issued in
   * module state, and a sibling test running on the real clock would
   * otherwise leave that ahead of this test's fake one, so the
   * backwards-clock guard would (correctly) pin the timestamp.
   */
  it("encodes the current time in the leading 48 bits", async () => {
    vi.resetModules();
    vi.useFakeTimers();

    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(now);

    const fresh = await import("../src/monotonic-id.js");
    const id = fresh.monotonicUuid();
    const encoded = Number.parseInt(id.slice(0, 13).replace("-", ""), 16);

    expect(encoded).toBe(now.getTime());
  });

  /** NTP can step the clock back mid-run; the sequence must not follow it. */
  it("keeps ascending when the clock jumps backwards", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));

    const before = monotonicUuid();

    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));

    const after = monotonicUuid();

    expect(after > before).toBe(true);
  });

  it("does not repeat an id across a large burst", () => {
    const ids = Array.from({ length: 20_000 }, () => monotonicUuid());

    expect(new Set(ids).size).toBe(20_000);
  });
});
