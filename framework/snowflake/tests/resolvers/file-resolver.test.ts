import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSequenceResolver } from "../../src/sequence-resolvers/file-sequence-resolver.js";
import { Snowflake } from "../../src/snowflake.js";

let file: string;
let dir: string;

beforeEach(async () => {
  Snowflake.reset();
  dir = await mkdtemp(path.join(tmpdir(), "snowflake-file-"));
  file = path.join(dir, "sequence.json");
});

afterEach(async () => {
  Snowflake.reset();
  await rm(dir, { recursive: true, force: true });
});

describe("FileSequenceResolver", () => {
  it("resolves a sequence and advances after the per-microsecond budget is exhausted", async () => {
    // File resolver increments then returns, so the first sequence in a
    // microsecond is 1. Default maxSequence is 7 (3 bits), 7 IDs then wait.
    const base = Date.now() * 1000;
    const times = [
      base, // seq 1
      base, // seq 2
      base, // seq 3
      base, // seq 4
      base, // seq 5
      base, // seq 6
      base, // seq 7
      base, // exhausted, consumed by the wait loop
      base + 1, // seq 1 of the next microsecond
    ];

    Snowflake.timestampResolver(() => times.shift()!);
    Snowflake.sequenceResolver(new FileSequenceResolver(file));

    const ids: bigint[] = [];

    for (let i = 0; i < 8; i++) {
      ids.push(await Snowflake.id());
    }

    expect(new Set(ids).size).toBe(8);

    const parsed = ids.map((id) => Snowflake.parse(id));

    for (let i = 0; i < 7; i++) {
      expect(parsed[i]!.sequence).toBe(i + 1);
      expect(parsed[i]!.timestamp).toBe(parsed[0]!.timestamp);
    }

    expect(parsed[7]!.sequence).toBe(1);
    expect(parsed[7]!.timestamp).toBe(parsed[0]!.timestamp + 1);
  });
});
