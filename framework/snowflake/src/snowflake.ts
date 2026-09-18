import { setTimeout as delay } from "node:timers/promises";
import { SnowflakeException } from "./errors.js";
import { formatLocalDateTime, parseEpochToMicroseconds } from "./epoch-microseconds.js";
import type {
  IdentifierResolver,
  IdentifierResolverFn,
} from "./identifier-resolvers/identifier-resolver.js";
import { SnowflakeIdentifierResolver } from "./identifier-resolvers/snowflake-identifier-resolver.js";
import type {
  SequenceResolver,
  SequenceResolverFn,
} from "./sequence-resolvers/sequence-resolver.js";
import { MemorySequenceResolver } from "./sequence-resolvers/memory-sequence-resolver.js";
import type {
  TimestampResolver,
  TimestampResolverFn,
} from "./timestamp-resolvers/timestamp-resolver.js";
import { MicrosecondTimestampResolver } from "./timestamp-resolvers/microsecond-timestamp-resolver.js";

export interface ParsedSnowflake {
  timestamp: number;
  sequence: number;
  worker: number;
  cluster: number;
  epoch: number;
  datetime: string;
}

type SequenceResolverInput = SequenceResolver | SequenceResolverFn | null;
type TimestampResolverInput = TimestampResolver | TimestampResolverFn | null;
type IdentifierResolverInput = IdentifierResolver | IdentifierResolverFn | null;

/**
 * 63-bit Snowflake IDs with microsecond precision.
 *
 * Default layout (configurable via `configureSignature()` before the
 * first ID is generated): `[ timestamp (50) | cluster (5) | worker (5)
 * | sequence (3) ]`. Sequence bits are always derived as
 * `13 - workerIdBits - clusterIdBits` and must remain ≥ 3.
 *
 * IDs are returned as `bigint`. They exceed `Number.MAX_SAFE_INTEGER`,
 * so a `number` would round them into a different id, and they belong in
 * a `bigInteger` column. Use `parse()` to unpack the fields.
 *
 * `JSON.stringify` throws on a `bigint`, which is deliberate rather than
 * unfortunate: it means an id cannot be serialised without a decision
 * being made about it. The framework's own serialisers make that
 * decision (a decimal string) — see `Resource` and `Model.toJSON()`.
 *
 * ```ts
 * Snowflake.configure("2025-01-01 00:00:00", 1, 1);
 * const id = await Snowflake.id(); // 9048372019229466888n
 * ```
 */
export class Snowflake {
  static readonly DEFAULT_EPOCH_START = "2021-02-02 00:00:00";
  static readonly DEFAULT_WORKER_ID = 1;
  static readonly DEFAULT_CLUSTER_ID = 1;

  static readonly ID_BITS = 63;
  static readonly TIMESTAMP_BITS = 50;
  static readonly NODE_BITS = Snowflake.ID_BITS - Snowflake.TIMESTAMP_BITS;

  static readonly DEFAULT_WORKER_ID_BITS = 5;
  static readonly DEFAULT_CLUSTER_ID_BITS = 5;
  static readonly DEFAULT_SEQUENCE_BITS = 3;
  static readonly MIN_SEQUENCE_BITS = 3;

  static worker = Snowflake.DEFAULT_WORKER_ID;
  static cluster = Snowflake.DEFAULT_CLUSTER_ID;

  protected static epoch: number | null = null;
  protected static workerIdBitWidth = Snowflake.DEFAULT_WORKER_ID_BITS;
  protected static clusterIdBitWidth = Snowflake.DEFAULT_CLUSTER_ID_BITS;
  protected static sequenceBitWidth = Snowflake.DEFAULT_SEQUENCE_BITS;
  protected static maxSequenceValue = (1 << Snowflake.DEFAULT_SEQUENCE_BITS) - 1;
  protected static signatureFrozen = false;

  protected static sequenceResolverValue: SequenceResolverInput = null;
  protected static timestampResolverValue: TimestampResolverInput = null;
  protected static identifierResolverValue: IdentifierResolverInput = null;

  static workerIdBits(): number {
    return this.workerIdBitWidth;
  }

  static clusterIdBits(): number {
    return this.clusterIdBitWidth;
  }

  static sequenceBits(): number {
    return this.sequenceBitWidth;
  }

  static maxSequence(): number {
    return this.maxSequenceValue;
  }

  /**
   * Configure the node bit layout. Sequence bits are derived as
   * `NODE_BITS - workerIdBits - clusterIdBits` (minimum 3).
   *
   * Must be called before the first ID is generated. Changing the
   * signature after IDs exist breaks `parse()` and can cause collisions.
   */
  static configureSignature(
    workerIdBits = Snowflake.DEFAULT_WORKER_ID_BITS,
    clusterIdBits = Snowflake.DEFAULT_CLUSTER_ID_BITS,
  ): void {
    if (this.signatureFrozen) {
      throw new SnowflakeException(
        "Snowflake signature is frozen after the first ID has been generated.",
      );
    }

    if (workerIdBits < 0 || workerIdBits > 10) {
      throw new SnowflakeException("workerIdBits must be between 0 and 10.");
    }

    if (clusterIdBits < 0 || clusterIdBits > 10) {
      throw new SnowflakeException("clusterIdBits must be between 0 and 10.");
    }

    if (workerIdBits + clusterIdBits > this.NODE_BITS - this.MIN_SEQUENCE_BITS) {
      throw new SnowflakeException(
        `workerIdBits + clusterIdBits must be <= ${this.NODE_BITS - this.MIN_SEQUENCE_BITS} so sequence bits remain >= ${this.MIN_SEQUENCE_BITS}.`,
      );
    }

    this.workerIdBitWidth = workerIdBits;
    this.clusterIdBitWidth = clusterIdBits;
    this.sequenceBitWidth = this.NODE_BITS - workerIdBits - clusterIdBits;
    this.maxSequenceValue = (1 << this.sequenceBitWidth) - 1;
  }

  static sequenceResolver(resolver: SequenceResolverInput): void {
    this.sequenceResolverValue = resolver;
  }

  static timestampResolver(resolver: TimestampResolverInput): void {
    this.timestampResolverValue = resolver;
  }

  static identifierResolver(resolver: IdentifierResolverInput): void {
    this.identifierResolverValue = resolver;
  }

  static configure(epochStart: string, cluster: number, worker: number): void {
    this.assertFitsBitWidth("cluster", cluster, this.clusterIdBitWidth);
    this.assertFitsBitWidth("worker", worker, this.workerIdBitWidth);

    this.epoch = parseEpochToMicroseconds(epochStart);
    this.cluster = cluster;
    this.worker = worker;
  }

  /**
   * Reset all static configuration and resolvers back to their defaults.
   *
   * Primarily useful in test suites to avoid leaking global state between
   * tests (e.g. a resolver configured by the framework integration
   * bleeding into a standalone test).
   */
  static reset(): void {
    this.epoch = null;
    this.worker = this.DEFAULT_WORKER_ID;
    this.cluster = this.DEFAULT_CLUSTER_ID;
    this.workerIdBitWidth = this.DEFAULT_WORKER_ID_BITS;
    this.clusterIdBitWidth = this.DEFAULT_CLUSTER_ID_BITS;
    this.sequenceBitWidth = this.DEFAULT_SEQUENCE_BITS;
    this.maxSequenceValue = (1 << this.DEFAULT_SEQUENCE_BITS) - 1;
    this.signatureFrozen = false;
    this.sequenceResolverValue = null;
    this.timestampResolverValue = null;
    this.identifierResolverValue = null;
  }

  static async getSequence(time: number): Promise<number> {
    this.sequenceResolverValue ??= new MemorySequenceResolver();

    if (typeof this.sequenceResolverValue === "function") {
      return this.sequenceResolverValue(time);
    }

    return this.sequenceResolverValue.sequence(time);
  }

  static async id(group: string | null = null): Promise<bigint> {
    return this.generate(group);
  }

  /**
   * Generate the 64-bit unique id as a signed BigInt (63 bits of payload;
   * bit 63 set on timestamp overflow produces a negative value, matching
   * PHP's signed 64-bit integers).
   */
  protected static async generate(group: string | null = null): Promise<bigint> {
    this.signatureFrozen = true;

    if (this.epoch === null) {
      const maxCluster = (1 << this.clusterIdBitWidth) - 1;
      const maxWorker = (1 << this.workerIdBitWidth) - 1;

      this.configure(
        this.DEFAULT_EPOCH_START,
        Math.min(this.DEFAULT_CLUSTER_ID, maxCluster),
        Math.min(this.DEFAULT_WORKER_ID, maxWorker),
      );
    }

    let time = await this.timestamp();

    let sequenceId = await this.getSequence(time);

    while (sequenceId > this.maxSequenceValue) {
      await delay(1);
      time = await this.timestamp();
      sequenceId = await this.getSequence(time);
    }

    const lapsed = time - this.epoch!;

    return this.toSnowflakeId(lapsed, sequenceId, group);
  }

  static async toSnowflakeId(
    time: number,
    sequence: number,
    group: string | null,
  ): Promise<bigint> {
    this.identifierResolverValue ??= new SnowflakeIdentifierResolver();

    const raw =
      typeof this.identifierResolverValue === "function"
        ? await this.identifierResolverValue(time, sequence, group)
        : await this.identifierResolverValue.identifier(time, sequence, group);

    return BigInt.asIntN(64, typeof raw === "bigint" ? raw : BigInt(raw));
  }

  static async timestamp(): Promise<number> {
    this.timestampResolverValue ??= new MicrosecondTimestampResolver();

    if (typeof this.timestampResolverValue === "function") {
      return this.timestampResolverValue();
    }

    return this.timestampResolverValue.timestamp();
  }

  static parse(id: string | number | bigint): ParsedSnowflake {
    const bits = BigInt.asUintN(64, BigInt(id));

    const sequenceBits = this.sequenceBitWidth;
    const workerIdBits = this.workerIdBitWidth;
    const clusterIdBits = this.clusterIdBitWidth;

    const sequenceMask = (1n << BigInt(sequenceBits)) - 1n;
    const workerMask = workerIdBits > 0 ? (1n << BigInt(workerIdBits)) - 1n : 0n;
    const clusterMask = clusterIdBits > 0 ? (1n << BigInt(clusterIdBits)) - 1n : 0n;

    const sequence = Number(bits & sequenceMask);
    const worker = workerIdBits > 0 ? Number((bits >> BigInt(sequenceBits)) & workerMask) : 0;
    const cluster =
      clusterIdBits > 0 ? Number((bits >> BigInt(sequenceBits + workerIdBits)) & clusterMask) : 0;
    const timestamp = Number(bits >> BigInt(sequenceBits + workerIdBits + clusterIdBits));

    const epoch = this.epoch ?? parseEpochToMicroseconds(this.DEFAULT_EPOCH_START);
    const datetime = formatLocalDateTime(Math.floor((timestamp + epoch) / 1000 / 1000));

    return { timestamp, sequence, worker, cluster, epoch, datetime };
  }

  protected static assertFitsBitWidth(field: string, value: number, bits: number): void {
    const maxExclusive = 1 << bits;

    if (value < 0 || value >= maxExclusive) {
      throw new SnowflakeException(
        `${field} id ${value} does not fit in ${bits} bit(s) (valid range: 0..${maxExclusive - 1}).`,
      );
    }
  }
}
