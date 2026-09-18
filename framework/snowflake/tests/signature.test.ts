import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SnowflakeException } from "../src/errors.js";
import { MemorySequenceResolver } from "../src/sequence-resolvers/memory-sequence-resolver.js";
import { Snowflake } from "../src/snowflake.js";

beforeEach(() => Snowflake.reset());
afterEach(() => Snowflake.reset());

describe("Snowflake signature", () => {
  it("default signature is 5 worker, 5 cluster, 3 sequence bits", async () => {
    expect(Snowflake.workerIdBits()).toBe(5);
    expect(Snowflake.clusterIdBits()).toBe(5);
    expect(Snowflake.sequenceBits()).toBe(3);
    expect(Snowflake.maxSequence()).toBe(7);

    const parsed = Snowflake.parse(await Snowflake.id());
    expect(parsed.worker).toBe(1);
    expect(parsed.cluster).toBe(1);
    expect(parsed.sequence).toBeGreaterThanOrEqual(0);
    expect(parsed.sequence).toBeLessThanOrEqual(7);
  });

  it("configureSignature derives sequence bits from worker and cluster bits", async () => {
    Snowflake.configureSignature(10, 0);

    expect(Snowflake.workerIdBits()).toBe(10);
    expect(Snowflake.clusterIdBits()).toBe(0);
    expect(Snowflake.sequenceBits()).toBe(3);
    expect(Snowflake.maxSequence()).toBe(7);

    Snowflake.configure("2025-01-01 00:00:00", 0, 1023);

    const parsed = Snowflake.parse(await Snowflake.id());
    expect(parsed.cluster).toBe(0);
    expect(parsed.worker).toBe(1023);
  });

  it("configureSignature with zero worker and cluster bits maximises sequence bits", async () => {
    Snowflake.configureSignature(0, 0);

    expect(Snowflake.sequenceBits()).toBe(13);
    expect(Snowflake.maxSequence()).toBe(8191);

    const parsed = Snowflake.parse(await Snowflake.id());
    expect(parsed.cluster).toBe(0);
    expect(parsed.worker).toBe(0);
  });

  it.each([
    [11, 0],
    [0, 11],
    [6, 5],
    [-1, 0],
  ])("configureSignature rejects invalid bit widths (%i, %i)", (worker, cluster) => {
    expect(() => Snowflake.configureSignature(worker, cluster)).toThrow(SnowflakeException);
  });

  it("configureSignature cannot be called after the first id is generated", async () => {
    await Snowflake.id();
    expect(() => Snowflake.configureSignature(4, 4)).toThrow(SnowflakeException);
  });

  it("configure rejects worker or cluster ids that do not fit the signature", () => {
    Snowflake.configureSignature(2, 2);
    expect(() => Snowflake.configure("2025-01-01 00:00:00", 4, 0)).toThrow(SnowflakeException);
  });

  it("reset restores default signature and allows reconfiguration", async () => {
    Snowflake.configureSignature(0, 0);
    await Snowflake.id();

    Snowflake.reset();

    expect(Snowflake.sequenceBits()).toBe(3);

    Snowflake.configureSignature(8, 2);
    expect(Snowflake.sequenceBits()).toBe(3);
    expect(Snowflake.workerIdBits()).toBe(8);
    expect(Snowflake.clusterIdBits()).toBe(2);
  });

  it("default memory sequence resolver produces unique ids in-process", async () => {
    const ids: bigint[] = [];

    for (let i = 0; i < 1000; i++) {
      ids.push(await Snowflake.id());
    }

    expect(ids).toHaveLength(1000);
    expect(new Set(ids).size).toBe(1000);
  });

  it("memory sequence resolver can be set explicitly", async () => {
    Snowflake.sequenceResolver(new MemorySequenceResolver());
    expect(String(await Snowflake.id())).toMatch(/^\d+$/);
  });
});
