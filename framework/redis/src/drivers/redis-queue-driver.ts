import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type {
  QueueDriver,
  QueuedJob,
  PushOptions,
  ChainedJob,
  JobState,
  FailedJobRepository,
  FailedJobRecord,
} from "@mahiframework/queue";
import type { RedisConnection } from "../redis-connection.js";

/**
 * The exact serialized payload a job was reserved with, stashed on the
 * `QueuedJob` object so `delete()`/`release()`/`fail()` can remove it from
 * the reserved set byte-for-byte, without depending on a re-serialization
 * producing an identical string. A symbol key so it never leaks into a
 * job's JSON or a payload.
 */
const RESERVED_RAW = Symbol("redis-queue-reserved-raw");

interface ReservedJob extends QueuedJob {
  [RESERVED_RAW]?: string;
}

interface JobEnvelope {
  id: string;
  jobClass: string;
  state: JobState;
  attempts: number;
  chain?: ChainedJob[];
}

interface FailedEnvelope {
  id: string;
  jobClass: string;
  queue: string;
  state: JobState;
  chain?: ChainedJob[];
  error: string;
  failedAt: string;
}

export interface RedisQueueDriverOptions {
  /**
   * Seconds after which a reserved job is presumed abandoned and migrated
   * back onto the ready list. **The crash-recovery mechanism**: a worker
   * killed mid-job leaves its job in the reserved set, and without a
   * visibility timeout nothing would ever put it back. The job is
   * stranded, not failed, invisible to every command. Default 90, matching
   * Laravel. Must exceed the longest a job can legitimately run.
   */
  retryAfterSeconds?: number;
  /** The connection name recorded on failed jobs, for `queue:retry`. Default `"redis"`. */
  connectionName?: string;
}

/**
 * A Redis-backed `QueueDriver`. Four keys per named queue, all sharing a
 * `{queue}` hash tag so a Redis Cluster keeps them in one slot, every Lua
 * script here touches two or three of them at once, and Cluster refuses
 * multi-key commands that span slots:
 *
 *   - `queues:{name}`, a list of ready jobs (`LPUSH` head,
 *                                 reserved from the tail, so FIFO).
 *   - `queues:{name}:delayed`. A sorted set of not-yet-available jobs,
 *                                 scored by their availability time (ms).
 *   - `queues:{name}:reserved`. A sorted set of in-flight jobs, scored
 *                                 by **when they expire** (reserved-at +
 *                                 `retryAfterSeconds`). A zset, not a
 *                                 list, precisely so expiry is a range
 *                                 query.
 *   - `queues:{name}:failed`, a hash of failed jobs by id, backing
 *                                 `queue:failed`/`retry`/`forget`/`flush`.
 *
 * ## Every mutation is one Lua script
 *
 * `pop()` migrates due delayed jobs, migrates *expired reserved* jobs
 * (incrementing their attempts), and reserves the oldest ready job.
 * `release()` moves a job from reserved back to ready/delayed. `fail()`
 * moves it from reserved into the failed hash. Each is a single
 * `EVALSHA`, because the alternative, `LREM` then `LPUSH` from the
 * client, loses the job outright if the worker dies between the two
 * commands, which is exactly the failure this driver exists to survive.
 *
 * Scripts are loaded once and invoked by SHA; a `NOSCRIPT` reply (the
 * server restarted or its script cache was flushed) transparently reloads
 * and retries, so nothing ships a multi-kilobyte script body on every
 * poll.
 */
export class RedisQueueDriver implements QueueDriver, FailedJobRepository {
  private readonly client: Redis;
  private readonly keyPrefix: string;
  private readonly queue: string;
  private readonly retryAfterSeconds: number;
  private readonly connectionName: string;
  /** Cached `SCRIPT LOAD` SHAs, keyed by script body. */
  private readonly shas = new Map<string, Promise<string>>();

  constructor(
    connection: RedisConnection,
    /** Base queue name; defaults to `"default"`. All four keys derive from it. */
    queue = "default",
    options: RedisQueueDriverOptions = {},
  ) {
    this.client = connection.client();
    this.keyPrefix = connection.keyPrefix();
    this.queue = queue;
    this.retryAfterSeconds = options.retryAfterSeconds ?? 90;
    this.connectionName = options.connectionName ?? "redis";
  }

  /**
   * All four keys for one queue share a `{name}` hash tag so Redis
   * Cluster hashes them to the same slot. Without it every Lua script
   * here (each of which touches two keys) is a cross-slot error on
   * Cluster. The scripts would work in dev against a single node and
   * fail on the first day in production.
   */
  private ready(queue: string): string {
    return `queues:{${queue}}`;
  }

  private delayed(queue: string): string {
    return `queues:{${queue}}:delayed`;
  }

  private reserved(queue: string): string {
    return `queues:{${queue}}:reserved`;
  }

  private failedKey(queue: string): string {
    return `queues:{${queue}}:failed`;
  }

  /**
   * Every queue's failed hash, not just this driver's default queue.
   *
   * Failed jobs are stored under `failedKey(job.queue)`, so a job that ran
   * on a non-default queue lands in a different hash, invisible to a
   * `queue:failed`/`queue:retry` that only looked at `this.queue`. Discover
   * all of them by scanning for the `queues:{*}:failed` pattern.
   *
   * ioredis auto-prefixes command KEYS with its `keyPrefix` but NOT a
   * SCAN MATCH pattern, and returns matched keys WITH the prefix, so the
   * pattern is prefixed manually here and the prefix stripped back off the
   * results before they are handed to prefix-aware commands.
   */
  private async discoverFailedKeys(): Promise<string[]> {
    const match = `${this.keyPrefix}queues:{*}:failed`;
    const found: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await this.client.scan(cursor, "MATCH", match, "COUNT", 100);
      cursor = next;

      for (const key of batch) {
        found.push(this.keyPrefix ? key.slice(this.keyPrefix.length) : key);
      }
    } while (cursor !== "0");

    return found;
  }

  async push(jobClass: string, state: JobState, options: PushOptions = {}): Promise<void> {
    const envelope: JobEnvelope = { id: randomUUID(), jobClass, state: state ?? null, attempts: 0 };

    if (options.chain && options.chain.length > 0) {
      envelope.chain = options.chain;
    }

    await this.enqueue(options.queue ?? this.queue, envelope, options.delaySeconds ?? 0);
  }

  async pop(queue?: string): Promise<QueuedJob | undefined> {
    const name = queue ?? this.queue;
    const now = Date.now();

    // Both migrations before reserving, so a job that just came due (or
    // was just abandoned) is a candidate on this very poll rather than
    // the next one.
    await this.evalScript(MIGRATE_DUE_LUA, [this.delayed(name), this.ready(name)], [String(now)]);
    await this.evalScript(
      RECLAIM_EXPIRED_LUA,
      [this.reserved(name), this.ready(name)],
      [String(now)],
    );

    const raw = (await this.evalScript(
      RESERVE_LUA,
      [this.ready(name), this.reserved(name)],
      [String(now + this.retryAfterSeconds * 1000)],
    )) as string | null;

    if (raw === null || raw === undefined) {
      return undefined;
    }

    const envelope = JSON.parse(raw) as JobEnvelope;
    const job: ReservedJob = {
      id: envelope.id,
      jobClass: envelope.jobClass,
      state: envelope.state,
      attempts: envelope.attempts,
      queue: name,
      ...(envelope.chain && envelope.chain.length > 0 ? { chain: envelope.chain } : {}),
    };
    job[RESERVED_RAW] = raw;

    return job;
  }

  /**
   * Take the job out of the reserved set and re-enqueue it with one more
   * attempt, as a single script, so a crash between the two can't lose
   * the job (the previous `LREM` + `LPUSH` pair could, and did).
   */
  async release(job: QueuedJob, delaySeconds = 0): Promise<void> {
    const name = job.queue ?? this.queue;
    const raw = (job as ReservedJob)[RESERVED_RAW];

    const envelope: JobEnvelope = {
      // Redis ids are strings of this driver's own making; the wider
      // `QueuedJob.id` exists for the database driver's snowflakes.
      id: String(job.id),
      jobClass: job.jobClass,
      state: job.state ?? null,
      attempts: job.attempts + 1,
      ...(job.chain && job.chain.length > 0 ? { chain: job.chain } : {}),
    };

    const target = delaySeconds > 0 ? this.delayed(name) : this.ready(name);
    await this.evalScript(
      RELEASE_LUA,
      [this.reserved(name), target],
      [
        raw ?? "",
        JSON.stringify(envelope),
        delaySeconds > 0 ? "delayed" : "ready",
        String(Date.now() + delaySeconds * 1000),
      ],
    );
  }

  async delete(job: QueuedJob): Promise<void> {
    const raw = (job as ReservedJob)[RESERVED_RAW];

    if (raw === undefined) {
      return;
    }

    await this.client.zrem(this.reserved(job.queue ?? this.queue), raw);
  }

  /**
   * Move the job from reserved into the failed hash, atomically. The
   * whole envelope is stored, payload, chain, queue, so `retry()` can
   * put it back exactly as it was rather than as a chainless orphan.
   */
  async fail(job: QueuedJob, error: Error): Promise<void> {
    const name = job.queue ?? this.queue;
    const raw = (job as ReservedJob)[RESERVED_RAW];

    const record: FailedEnvelope = {
      id: String(job.id),
      jobClass: job.jobClass,
      queue: name,
      state: job.state ?? null,
      ...(job.chain && job.chain.length > 0 ? { chain: job.chain } : {}),
      // The full stack when there is one, the same thing the database
      // driver stores. A bare `error.message` throws away the only
      // information that makes a production failure diagnosable.
      error: error.stack ?? error.message,
      failedAt: new Date().toISOString(),
    };

    await this.evalScript(
      FAIL_LUA,
      [this.reserved(name), this.failedKey(name)],
      [raw ?? "", String(job.id), JSON.stringify(record)],
    );
  }

  /** Number of jobs waiting in the ready list, handy for tests/monitoring. */
  async size(queue?: string): Promise<number> {
    return this.client.llen(this.ready(queue ?? this.queue));
  }

  /** Delete every ready and delayed job on a queue without running it (`queue:clear`). */
  async clear(queue?: string): Promise<number> {
    const name = queue ?? this.queue;
    const ready = await this.client.llen(this.ready(name));
    const delayed = await this.client.zcard(this.delayed(name));
    await this.client.del(this.ready(name), this.delayed(name));

    return ready + delayed;
  }

  async listFailed(): Promise<FailedJobRecord[]> {
    const keys = await this.discoverFailedKeys();
    const batches = await Promise.all(keys.map((key) => this.client.hvals(key)));

    return batches
      .flat()
      .map((raw) => this.toFailedRecord(raw))
      .filter((record): record is FailedJobRecord => record !== undefined)
      .sort((a, b) => (a.failedAt < b.failedAt ? 1 : a.failedAt > b.failedAt ? -1 : 0));
  }

  async findFailed(id: string): Promise<FailedJobRecord | undefined> {
    const key = await this.failedKeyHolding(id);

    if (key === undefined) {
      return undefined;
    }

    const raw = await this.client.hget(key, id);

    return raw === null ? undefined : this.toFailedRecord(raw);
  }

  /**
   * Re-enqueue a failed job (fresh id, attempts reset, chain and queue
   * restored) and drop the failed-hash entry, one script, so a crash
   * can't leave the job both queued and recorded as failed. Locates the
   * job across every queue's failed hash, not just the default one.
   */
  async retry(id: string): Promise<boolean> {
    const failedKey = await this.failedKeyHolding(id);

    if (failedKey === undefined) {
      return false;
    }

    const raw = await this.client.hget(failedKey, id);

    if (raw === null) {
      return false;
    }

    const record = JSON.parse(raw) as FailedEnvelope;
    const name = record.queue ?? this.queue;

    const envelope: JobEnvelope = {
      id: randomUUID(),
      jobClass: record.jobClass,
      state: record.state ?? null,
      attempts: 0,
      ...(record.chain && record.chain.length > 0 ? { chain: record.chain } : {}),
    };

    await this.evalScript(RETRY_LUA, [failedKey, this.ready(name)], [id, JSON.stringify(envelope)]);

    return true;
  }

  async forget(id: string): Promise<boolean> {
    const key = await this.failedKeyHolding(id);

    if (key === undefined) {
      return false;
    }

    return (await this.client.hdel(key, id)) > 0;
  }

  async flush(olderThanHours?: number): Promise<number> {
    const keys = await this.discoverFailedKeys();
    const counts = await Promise.all(keys.map((key) => this.flushOne(key, olderThanHours)));

    return counts.reduce((total, n) => total + n, 0);
  }

  private async flushOne(key: string, olderThanHours?: number): Promise<number> {
    if (olderThanHours === undefined) {
      const count = await this.client.hlen(key);
      await this.client.del(key);

      return count;
    }

    const cutoff = new Date(Date.now() - olderThanHours * 3600 * 1000).toISOString();
    const entries = await this.client.hgetall(key);
    const stale = Object.entries(entries)
      .filter(([, raw]) => {
        try {
          return (JSON.parse(raw) as FailedEnvelope).failedAt < cutoff;
        } catch {
          return false;
        }
      })
      .map(([id]) => id);

    if (stale.length === 0) {
      return 0;
    }

    return this.client.hdel(key, ...stale);
  }

  /** The failed hash (across all queues) holding `id`, or undefined if none does. */
  private async failedKeyHolding(id: string): Promise<string | undefined> {
    // Try the default queue first, the overwhelmingly common case, before
    // paying for a SCAN across every queue's failed hash.
    if ((await this.client.hexists(this.failedKey(this.queue), id)) === 1) {
      return this.failedKey(this.queue);
    }

    for (const key of await this.discoverFailedKeys()) {
      if ((await this.client.hexists(key, id)) === 1) {
        return key;
      }
    }

    return undefined;
  }

  private async enqueue(queue: string, envelope: JobEnvelope, delaySeconds: number): Promise<void> {
    const serialized = JSON.stringify(envelope);

    if (delaySeconds > 0) {
      await this.client.zadd(this.delayed(queue), Date.now() + delaySeconds * 1000, serialized);
    } else {
      await this.client.lpush(this.ready(queue), serialized);
    }
  }

  private toFailedRecord(raw: string): FailedJobRecord | undefined {
    let record: FailedEnvelope;
    try {
      record = JSON.parse(raw) as FailedEnvelope;
    } catch {
      return undefined;
    }

    return {
      id: record.id,
      jobClass: record.jobClass,
      payloadJson: JSON.stringify(record.state ?? null),
      error: record.error,
      failedAt: record.failedAt,
      connection: this.connectionName,
      queue: record.queue,
      ...(record.chain && record.chain.length > 0 ? { chain: record.chain } : {}),
    };
  }

  /**
   * Run a script by SHA, loading it on first use and reloading on
   * `NOSCRIPT`.
   *
   * `EVAL` would ship the whole script body on every call, several
   * kilobytes per poll, per worker, forever. `EVALSHA` sends 40 bytes.
   * The `NOSCRIPT` retry covers a server restart or a `SCRIPT FLUSH`
   * between load and use, which is the one thing that makes naive SHA
   * caching unsafe.
   */
  private async evalScript(script: string, keys: string[], args: string[]): Promise<unknown> {
    const sha = await this.loadScript(script);
    try {
      return await this.client.evalsha(sha, keys.length, ...keys, ...args);
    } catch (error) {
      if (!isNoScriptError(error)) {
        throw error;
      }

      // The server forgot it. Drop the cached SHA so the reload below
      // isn't served from our own stale promise, then try once more.
      this.shas.delete(script);
      const reloaded = await this.loadScript(script);

      return this.client.evalsha(reloaded, keys.length, ...keys, ...args);
    }
  }

  /**
   * The SHA for a script, loading it at most once per driver.
   *
   * The *promise* is cached rather than the resolved value, so N
   * concurrent first calls share one `SCRIPT LOAD` instead of racing.
   */
  private loadScript(script: string): Promise<string> {
    let pending = this.shas.get(script);

    if (!pending) {
      pending = this.client.script("LOAD", script) as Promise<string>;
      // A failed load must not be cached forever. The next call should
      // be free to try again (e.g. after a reconnect).
      pending.catch(() => this.shas.delete(script));
      this.shas.set(script, pending);
    }

    return pending;
  }
}

function isNoScriptError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("NOSCRIPT");
}

/**
 * KEYS[1] = delayed zset, KEYS[2] = ready list, ARGV[1] = now (ms).
 * Moves every member scored <= now onto the ready list. Atomic, so two
 * workers can't both migrate (and thus duplicate) the same job.
 */
const MIGRATE_DUE_LUA = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
for _, member in ipairs(due) do
  if redis.call('ZREM', KEYS[1], member) == 1 then
    redis.call('LPUSH', KEYS[2], member)
  end
end
return #due
`;

/**
 * KEYS[1] = reserved zset (scored by expiry), KEYS[2] = ready list,
 * ARGV[1] = now (ms).
 *
 * Puts every reservation that has expired back onto the ready list with
 * `attempts` incremented, the crash recovery. Incrementing here is what
 * stops a job that reliably kills its worker from being reclaimed
 * forever: each reclaim costs an attempt, so it eventually exhausts them
 * and the worker fails it (see `QueueWorkCommand`'s pre-run check).
 *
 * The `ZREM` guard makes the whole thing idempotent under concurrency:
 * only the caller whose ZREM actually removed the member re-pushes it.
 */
const RECLAIM_EXPIRED_LUA = `
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local moved = 0
for _, member in ipairs(expired) do
  if redis.call('ZREM', KEYS[1], member) == 1 then
    local ok, job = pcall(cjson.decode, member)
    if ok and type(job) == 'table' then
      job['attempts'] = (job['attempts'] or 0) + 1
      redis.call('LPUSH', KEYS[2], cjson.encode(job))
    else
      redis.call('LPUSH', KEYS[2], member)
    end
    moved = moved + 1
  end
end
return moved
`;

/**
 * KEYS[1] = ready list, KEYS[2] = reserved zset, ARGV[1] = expiry (ms).
 *
 * Pops the oldest ready job and records it as reserved-until-expiry in
 * one step, returning the raw payload. `RPOP` + `ZADD` as separate client
 * commands would drop the job entirely if the worker died between them.
 */
const RESERVE_LUA = `
local job = redis.call('RPOP', KEYS[1])
if not job then return nil end
redis.call('ZADD', KEYS[2], ARGV[1], job)
return job
`;

/**
 * KEYS[1] = reserved zset, KEYS[2] = ready list OR delayed zset.
 * ARGV[1] = the reserved payload to remove, ARGV[2] = the payload to
 * re-enqueue, ARGV[3] = "ready" | "delayed", ARGV[4] = available-at (ms).
 *
 * Remove-then-enqueue in one step: as two client commands, a crash in
 * between loses the job.
 */
const RELEASE_LUA = `
if ARGV[1] ~= '' then redis.call('ZREM', KEYS[1], ARGV[1]) end
if ARGV[3] == 'delayed' then
  redis.call('ZADD', KEYS[2], ARGV[4], ARGV[2])
else
  redis.call('LPUSH', KEYS[2], ARGV[2])
end
return 1
`;

/**
 * KEYS[1] = reserved zset, KEYS[2] = failed hash.
 * ARGV[1] = reserved payload, ARGV[2] = job id, ARGV[3] = failed record.
 *
 * Un-reserve and record as failed together, so a crash between them
 * can't leave the job to be reclaimed and failed a second time (a
 * duplicate row) or drop it silently.
 */
const FAIL_LUA = `
if ARGV[1] ~= '' then redis.call('ZREM', KEYS[1], ARGV[1]) end
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
return 1
`;

/**
 * KEYS[1] = failed hash, KEYS[2] = ready list.
 * ARGV[1] = failed id, ARGV[2] = the job envelope to re-enqueue.
 *
 * Requeue and forget together, so a retry can never both queue the job
 * and leave it listed as failed.
 */
const RETRY_LUA = `
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('LPUSH', KEYS[2], ARGV[2])
return 1
`;
