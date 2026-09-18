# Queues

A job is a class with a `handle()` method and its payload in its own
fields. You dispatch an instance; a driver persists the fields; a worker
in some other process rebuilds the instance and calls `handle()`.

```ts
import { app } from "@mahiframework/core";
import { Job } from "@mahiframework/queue";
import type { Post } from "../models/post.model.js";

export class LogPostCreatedJob extends Job {
  constructor(public readonly post: Post) {
    super();
  }

  handle(): void {
    app().logger.info("Post created (via queue)", {
      id: this.post.id,
      userId: this.post.user_id,
    });
  }
}
```

```ts
await Bus.dispatch(new LogPostCreatedJob(post));
```

Three drivers ship: `sync` (run inline), `database` (a `jobs` table), and
`fake` (record, never run). `@mahiframework/redis` adds a fourth.

## The `Job` base class

```ts
export abstract class Job {
  declare maxAttempts: number;                          // prototype default: 3
  declare afterCommit?: boolean;                        // defer dispatch until the tx commits
  abstract handle(): void | Promise<void>;
  backoff?(attempts: number): number;                   // SECONDS
  retryUntil?(): Date | number;
  timeout?(): number;                                   // SECONDS
  middleware?(): JobMiddleware[];
  failed?(error: Error): void | Promise<void>;
}
```

That is the entire contract. Everything except `handle()` is optional, and
everything reads its state off `this`.

**There is no `tries` property.** The real name is `maxAttempts`.

**There is no `delay` property and no `queue` property.** Delay is a
dispatch-site option (`Bus.dispatch(job, { delaySeconds: 60 })`), and so
are the connection and the named queue (`{ connection: "database", queue:
"emails" }`). A job doesn't get to decide where it runs; the caller does.

`afterCommit` is the one exception, and only because it's about the job's
own data dependency. A job that reads rows written by the transaction
dispatching it should say so once on the class, not at every call site.

**There is no `ShouldQueue` marker interface.** Extending `Job` *is* the
marker for "this is a queueable job".

**Uniqueness has two levels, and they solve different problems:**

- **Dispatch-time uniqueness**: a `static unique` marker on the class
  (`ShouldBeUnique`) stops a *duplicate* being enqueued at all. A burst of
  100 dispatches of the same unique job enqueues one row. See
  [Unique jobs](#unique-jobs) below.
- **Run-time exclusivity**: the `WithoutOverlapping` middleware stops two
  *already-enqueued* instances from *running* at the same time. It does
  not prevent duplicate dispatch. See [`WithoutOverlapping`](#withoutoverlapping).

Use `ShouldBeUnique` when a duplicate is meaningless work; use
`WithoutOverlapping` when duplicates are legitimate but must be serialised.

### Unique jobs

Mark the class with a `static unique` field and (optionally) implement
`uniqueId()`:

```ts
class SyncInventory extends Job {
  static unique = "untilFinished" as const;
  constructor(public readonly sku: string) { super(); }
  uniqueId(): string { return this.sku; }
  handle(): void { /* ... */ }
}

const queued = await Bus.dispatch(new SyncInventory("ABC")); // true
const dropped = await Bus.dispatch(new SyncInventory("ABC")); // false — dropped
```

`Bus.dispatch()`/`QueueManager.dispatch()` acquire a cache lock keyed by
`mahi:unique:<jobName>:<uniqueId>` before pushing. If it's already held,
the dispatch is a **silent no-op** returning `false`. The duplicate is
dropped, matching Laravel.

| `static unique` | Lock acquired | Lock released |
|---|---|---|
| `"untilFinished"` | at dispatch | when the job **finishes** (deleted after success, failed after exhausting attempts). A duplicate is dropped while one is queued OR running |
| `"untilProcessing"` | at dispatch | when a worker **starts** processing it (before `handle()`), so a new instance can be queued while one runs |

Optional hooks (read state off `this`):

- `uniqueId(): string`: distinguishes *which* unique job. Defaults to
  `""` (class-wide: only one may be queued at a time).
- `uniqueFor(): number`: the lock TTL in seconds (default: the
  connection's `uniqueFor`, then `3600`). This is the **crash safety
  net**: a worker that dies mid-job lets the lock expire rather than
  wedging the job forever. Set it above the job's worst-case runtime.
- `uniqueVia(): string | CacheStore`: which cache store backs the lock
  (default: the cache manager's default store).

**Store caveat.** Uniqueness is only as strong as the store. The `array`
store makes it **per-process** (fine for tests, wrong for multiple
workers); `file` covers one host; only Redis covers workers across hosts.
If no cache is configured at all, dispatch **fails open** (proceeds, with
a logged warning) rather than throwing.

The lock is acquired in the dispatching process and released in whichever
worker later runs the job, so release goes through `Lock.forceRelease()`
(owner-less, keyed), the worker recomputes the same key from the job's
class name and `uniqueId()`, so nothing about the lock is persisted in the
payload.

### `maxAttempts` lives on the prototype

```ts
Job.prototype.maxAttempts = 3;
```

Not a field initializer. This is deliberate and it has a visible
consequence.

`encodeJob()` serializes a job with `{ ...job }`, **own enumerable
fields only**. A prototype property is not an own field, so the default
`3` is never written into the payload. A rebuilt job inherits it from the
prototype instead. The payload stays small, and a job
enqueued before you changed the default picks up the new default on its
next attempt rather than carrying the old one forever.

Override it with a field initializer and the opposite happens, on
purpose:

```ts
export class ChargeOrderJob extends Job {
  override maxAttempts = 5;     // own field → serialized → restored on rebuild
  constructor(public readonly order: Order) { super(); }
  handle() { /* ... */ }
}
```

Now `5` *is* an own enumerable field, so `{ ...job }` captures it and
`Object.assign` restores it. An in-flight job keeps the value it was
dispatched with. Same for anything you set in the constructor
(`this.maxAttempts = 10`).

Both behaviours are correct; which one you want depends on whether the
number is a property of the code or a property of that particular
dispatch.

### `backoff(attempts)`

Seconds to wait before the next attempt, given the attempt count that just
failed (1-based).

```ts
backoff(attempts: number): number {
  return [5, 30, 120][attempts - 1] ?? 300;
}
```

Overrides the worker's default linear backoff. See
[The off-by-one in backoff](#the-off-by-one-in-backoff). It matters.

### `retryUntil()`

A wall-clock deadline past which the job stops being retried and goes
straight to `failed_jobs`, regardless of remaining attempts. Return a
`Date` or epoch milliseconds.

```ts
export class SyncInventoryJob extends Job {
  constructor(
    public readonly sku: string,
    public readonly deadline: number = Date.now() + 3_600_000,
  ) { super(); }

  retryUntil(): number { return this.deadline; }
  handle() { /* ... */ }
}
```

**Compute the deadline from a field, not from `Date.now()` inside the
method.** The job is rebuilt from its persisted fields on every attempt,
so `retryUntil() { return Date.now() + 3600_000 }` recomputes a *fresh*
hour on each attempt and the deadline slides forward forever. Capture it
at construction, where it gets serialized once.

### `timeout()`

A soft per-job timeout in seconds. When present, the worker races
`handle()` against a timer:

```ts
await Promise.race([work, timeout]);
```

If the timer wins, the attempt fails with `JobTimeoutError`
(`"Job exceeded its 30s timeout."`) and follows the normal
retry/fail path.

**This is cooperative, not a kill.** Unlike PHP's `pcntl`-based hard
termination, JavaScript cannot forcibly abort an in-flight `await`. The
`handle()` promise **keeps running in the background** after the race
rejects. A job that timed out may still complete its database writes,
still send its email, still hold its lock, minutes later, in a worker
that has already moved on and possibly already retried it.

Treat `timeout()` as a scheduling hint, not an isolation boundary. If a
job must be genuinely abortable, thread an `AbortSignal` through your own
I/O.

### `middleware()`

Returns `JobMiddleware[]` wrapping the call to `handle()`. See
[Job middleware](#job-middleware).

### `failed(error)`

Called after the job has exhausted its attempts (or blown its
`retryUntil`) and **after** `driver.fail()` has already moved it to
`failed_jobs`. Not called on a retry, and not called on a release.

```ts
async failed(error: Error): Promise<void> {
  app().logger.error("charge failed permanently", { orderId: this.order.id, error: error.message });
}
```

## The constructor never re-runs

This is the single most important thing to internalise about jobs.

```ts
export async function decodeJob(app, JobClass, state): Promise<Job> {
  const job = Object.create(JobClass.prototype) as Job;
  const fields = await decodeState(app, state);
  Object.assign(job, fields);
  return job;
}
```

`Object.create` gives an object with the right prototype chain, so all
the methods work, `instanceof` holds, prototype defaults apply, and
`Object.assign` puts the decoded fields back. Your constructor body is
**never executed** on the worker.

Practical rules:

- **Anything your constructor computes must be assigned to a field.**
  `this.slug = slugify(title)` survives. A local variable does not.
- **Constructor side effects run exactly once, at dispatch.** That's the
  point, a constructor that increments a counter or writes a row won't do
  it again on each retry.
- **Fields must be JSON-round-trippable**, with one exception: `Model`
  instances, which get special encoding (below). A `Date` field comes back
  as a string. A `Map` comes back as `{}`. A class instance that isn't a
  `Model` comes back as a plain object with the right keys and *no
  prototype*, its methods are gone.
- **Getters and methods live on the prototype**, so they survive
  perfectly. Only own enumerable data fields are serialized.

The `sync` driver performs the **same** round-trip, encode, then decode,
even though it never leaves the process. That is deliberate: a job that
works under `sync` and breaks under `database` because of a
non-serializable field would be the worst possible thing to discover in
production. Under `sync` you find out immediately.

## Registering jobs

A job must be registered under a stable name before it can be dispatched.
`JobRegistry` maps name → class and back.

```ts
export class PostsServiceProvider extends ServiceProvider {
  jobs(): Record<string, JobClass> {
    return {
      "posts:log-created": LogPostCreatedJob,
      "posts:welcome-author": WelcomePostAuthorJob,
    };
  }
}
```

`QueueServiceProvider.boot()` walks every provider's `jobs()` hook and
registers the pairs. See [Providers](../providers/).

Dispatching an unregistered job throws at the **dispatch** site:

```
Job [SomeJob] is not registered. Register it via a provider's jobs() hook
so it can be dispatched and reconstructed by name.
```

The name is what's persisted, not the class name, so it must be stable
across deploys and survive minification. Treat the strings as append-only,
like enum members: renaming one orphans every job already sitting in the
queue under the old name (the worker will fail them immediately as an
unknown class).

| Method | Purpose |
|---|---|
| `register(name, jobClass)` | Both directions at once. |
| `resolve(name)` | Name → class. Throws `Job [name] is not registered.` |
| `nameFor(job \| jobClass)` | Class → name. Throws with the guidance above. |
| `has(name)` | Boolean. |

## Model serialization

A job field holding a live `Model` is encoded to a compact reference:

```ts
{ __model: "Post", __id: "427185966743560456" }
```

The keys are deliberately ugly so a plain data object in a payload is
very unlikely to collide.

```ts
export class WelcomePostAuthorJob extends Job {
  constructor(
    public readonly author: User,
    public readonly post: Post,
  ) { super(); }

  handle(): void {
    app().logger.info("Welcoming post author", {
      userId: this.author.id,       // a live User instance
      postId: this.post.id,         // a live Post instance
    });
  }
}
```

`this.author` really is a `User`, freshly loaded, not a stale snapshot
from dispatch time. That freshness is the *reason* for the reference
encoding, beyond payload size: a job that runs five minutes after dispatch
should see the row as it is now.

### Requirements

Both are enforced, loudly, at dispatch:

**1. A `morphName`.**

```ts
interface PostAttributes {
  id: string;
  title: string;
}

export class Post extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
  morphName: "Post",
}) {}
```

Without it:

```
Cannot serialize model [Post] into a job payload: it has no static
morphName. Add `static override morphName = "..."` and register it via a
provider's models() hook.
```

`morphName` is decoupled from both `table` (renaming a table must not
break in-flight jobs) and the class name (survives minification). Like job
names, treat values as append-only.

**2. Registration via a provider's `models()` hook.**

```ts
models(): Array<AnyModelClass> {
  return [User, Post];
}
```

An unsaved model also throws, since there's no id to reference:

```
Cannot serialize model [Post] into a job payload: it has no primary-key
value (has it been saved?).
```

### What gets walked

| Value | Encoded |
|---|---|
| `Model` | → `{ __model, __id }` |
| `Collection` | → array, each item encoded |
| `Array` | recursed |
| Plain object (prototype is `Object.prototype` or `null`) | recursed |
| Anything else: `DateTime`, a custom class, a `Map` | passed through untouched |

Other class instances are **not** deeply traversed. No surprising walks
into arbitrary objects; the rule is predictable and you can reason about
it.

### Decoding is batched

```ts
for (const [morphName, ids] of idsByModel) {
  const modelClass = registry.resolve(morphName);
  const collection = await modelClass.findMany([...ids]);
  // ...
}
```

Three passes: collect every reference grouped by `morphName`, batch-load
each group with one `findMany()`, then rebuild the payload. A job carrying
an array of 500 `Post` references does **one** query, not 500. No N+1.

### Missing rows

If a referenced id has no row, behaviour depends on that model's
`static deleteWhenMissingModels`:

| Setting | Behaviour |
|---|---|
| `false` (default) | Throws `ModelNotFoundError`. The job fails and retries like any other error. |
| `true` | Throws the internal `SkipJobMissingModelError`. The job is **deleted from the queue without running**, and without being marked failed. |

`false` is right when a missing row is a bug. `true` is right for "send a
welcome email to this user" where the user may legitimately have been
deleted first.

If *any* referenced model is missing and that model has
`deleteWhenMissingModels = true`, the whole job is skipped. See
[Models](../models/).

## Dispatching

### `QueueManager`

`QueueManager extends Manager<QueueDriver>`, synchronous resolution,
per-name caching, same as every other manager.

| Method | Purpose |
|---|---|
| `connection(name?)` | Alias for `driver()`. |
| `connectionConfig(name)` | Raw config entry. |
| `extend(name, factory)` | Register a driver. |
| `swap(driver, name?)` | **Test-only.** Force a connection to resolve to `driver`, bypassing its factory and any cached instance. Defaults to the *default* connection. |
| `dispatch(job, options?)` | Enqueue one job. |
| `chain(jobs, options?)` | Enqueue an ordered chain. |

```ts
dispatch(job: Job, options?: { delaySeconds?: number; connection?: string; chain?: Job[] }): Promise<void>
chain(jobs: Job[], options?: { delaySeconds?: number; connection?: string }): Promise<void>
```

### The `Bus` facade

```ts
import { Bus } from "@mahiframework/queue";

await Bus.dispatch(new LogPostCreatedJob(post));
await Bus.dispatch(new SendDigestJob(user), { delaySeconds: 3600 });
await Bus.dispatch(new HeavyReportJob(id), { connection: "database" });
```

Two statics, `dispatch` and `chain`, proxying `QUEUE_TOKEN`. As with
every facade in Mahi, prefer injecting `QueueManager` where you already
have `app`.

### `await` means different things per driver

```ts
await Bus.dispatch(new LogPostCreatedJob(post));
```

| Connection | What the `await` resolved means |
|---|---|
| `sync` | The job **finished running**. Exceptions propagate to you. |
| `database` / `redis` | The job was **enqueued**. It has not run. |
| `fake` | The push was **recorded**. It will never run. |

This asymmetry is inherent to what "sync" means, and it's why the sync
driver is a genuine driver rather than a testing convenience: switching
`queue.default` from `sync` to `database` changes what your `await`
actually waits for, and it's better to understand that than to hide it.

The concrete failure mode: code that dispatches a job and then reads the
row that job was supposed to write works perfectly under `sync` and breaks
the moment you deploy with `database`.

### Chaining

Each link runs only after the previous one **succeeds**.

```ts
await Bus.chain([
  new ChargeOrderJob(order),
  new ShipOrderJob(order),
  new NotifyCustomerJob(order),
]);
```

`chain()` is sugar: the first job is dispatched with the rest attached as
its `chain`. The worker pops the first remaining link after a success,
dispatches it carrying the remainder forward, and so on. An empty array is
a no-op.

A failed link **stops the chain**. The remaining links are never
dispatched. A *released* link doesn't stop it; the release re-queues the
same job with its chain intact.

The next link is pushed with its already-serialized state, straight onto
the driver, rather than routed back through `dispatch()`. The state was
encoded once at the original dispatch, and re-encoding a job that was
never even rebuilt isn't possible anyway. Practical consequence: **a
chained job's model references are resolved from the ids captured at the
original dispatch**, and the chain always stays on the connection and
queue the worker is draining.

Uniqueness still applies to **each link independently**, matching
Laravel. A link whose class is `static unique` takes its lock as it is
pushed, exactly as a direct dispatch would; if an identical job is
already queued, that link is dropped, and so is the remainder of the
chain, which travels on that push. This is the same "a duplicate is a
silent no-op" contract `dispatch()` has, so the worker logs it rather
than leaving a chain that just stops.

### Dispatching inside a transaction

Consider the most ordinary code in the world:

```ts
await DB.transaction(async () => {
  const order = await Order.create({ ... });
  await Bus.dispatch(new ChargeOrderJob(order));
});
```

This is a race. The job carries `{ __model: "order", __id }`, and the
worker rehydrates it by loading that row. But the transaction hasn't
committed yet, so on MySQL/Postgres, where the job row goes in on a
different pooled connection and commits immediately, a worker can pop the
job and find no order. The job fails on a row that exists a millisecond
later.

`afterCommit` fixes it by holding the push until the outermost
transaction commits, and skipping it entirely if the transaction rolls
back:

```ts
await Bus.dispatch(new ChargeOrderJob(order), { afterCommit: true });
```

Three ways to turn it on, in precedence order:

| Where | How | Scope |
|---|---|---|
| Per dispatch | `Bus.dispatch(job, { afterCommit: true })` | This one call. |
| Per job class | `afterCommit = true` field on the `Job` | Every dispatch of that job. |
| Per connection | `afterCommit: true` in `config/queue.ts` | Everything on that connection. |

An explicit option always wins, so `{ afterCommit: false }` opts a single
dispatch out of a connection-wide default.

Semantics that follow from being built on the transaction context:

- **Nesting hoists.** A dispatch inside a nested `transaction()` waits for
  the *outermost* commit. A released savepoint isn't durable on its own.
- **A rolled-back savepoint discards its dispatches**, while the enclosing
  transaction's are untouched.
- **Exactly once.** Not once per nesting level.
- **Outside a transaction it's a no-op**: the push happens immediately.

It works on every driver, including `sync` (the job runs after the
commit, or never) and `fake` (which records the deferral, so
`assertPushedAfterCommit()` can check it).

Without `afterCommit`, the push participates in the transaction directly:
the `jobs` row is written on the transaction's own connection, so it
commits or rolls back with everything else. That's still a race against
workers. The row becomes visible at commit, which may be before the
dispatching code has finished, just a much narrower one.

## Drivers

### `sync`

Runs the job immediately, inline. `push()` resolves only once `handle()`
has finished or thrown.

```ts
async push(jobClass, state, options = {}) {
  const JobClass = this.registry.resolve(jobClass);
  let job;
  try {
    job = await decodeJob(this.app, JobClass, state);
  } catch (error) {
    if (error instanceof SkipJobMissingModelError) return;
    throw error;
  }
  await runJobThroughMiddleware(this.app, job);
  if (options.chain?.length) { /* run the next link inline */ }
}
```

Notice what it still does: the full serialize/rebuild round-trip, model
rehydration, the middleware pipeline, and chain advancement. Everything
except persistence and retries.

`pop()` always returns `undefined`. `release()`, `delete()` and `fail()`
are no-ops. Nothing was ever queued, so there's nothing to release, and
there is no `failed_jobs` for this driver. **A throwing sync job throws at
the dispatch site.** There is no retry, no backoff, no failed-jobs row.
`maxAttempts` is meaningless here.

A `ReleaseJobError` from middleware also surfaces to the caller, since
there's no queue to release back onto.

### `database`

Persists to a `jobs` table through the app's existing Kysely connection.
No new infrastructure.

```
jobs
  id            bigint  primary  (snowflake)
  queue         string  default 'default'
  job_class     string
  payload_json  text
  attempts      integer default 0
  available_at  timestamp
  reserved_at   timestamp nullable
  created_at    timestamp
  chain_json    text nullable

  index (queue, available_at, id)
```

```
failed_jobs
  id            bigint  primary  (snowflake)
  connection    string  nullable
  queue         string  nullable
  job_class     string
  payload_json  text
  chain_json    text nullable
  error         text
  failed_at     timestamp

  index (failed_at)
```

Run `./artisan migrate`, `QueueServiceProvider` contributes both
migrations. They're unused if you never resolve the `database` connection.

#### Eligibility and the visibility timeout

A row is eligible when it is **due** and **not currently held**:

```sql
queue = ?
AND available_at <= now
AND (reserved_at IS NULL OR reserved_at <= now - retryAfter)
```

That last clause is the important one. `pop()` sets `reserved_at`; if the
worker holding the job is killed (`SIGKILL`, OOM, a hardware fault),
nothing ever clears it. Without a **visibility timeout** the job is
stranded permanently: not queued, not failed, not in `queue:failed`, just
gone. `retryAfter` (default 90s, configurable per connection) is how long
a reservation is honoured before another worker may take it, and a
reclaimed job comes back with `attempts` incremented, so a job that
reliably kills its worker eventually lands in `failed_jobs` instead of
cycling forever.

**`retryAfter` must be longer than the longest a job can run**, including
its own `timeout()`. Set it too low and a slow-but-healthy job gets a
second worker running it concurrently.

**This is at-least-once, not exactly-once.** A job whose worker merely
*stalls* past `retryAfter` runs twice. Write `handle()` to be idempotent.

#### Reserving

How the reservation is taken depends on the dialect, because the right
answer differs:

**MySQL 8+ / Postgres**, one short transaction:

```sql
SELECT * FROM jobs WHERE <eligible> ORDER BY available_at, id
  LIMIT 1 FOR UPDATE SKIP LOCKED;
UPDATE jobs SET reserved_at = now WHERE id = ?;
```

`SKIP LOCKED` makes concurrent workers step over each other's locked rows
instead of queueing behind them, so throughput scales with worker count.

**SQLite**, read a small bounded batch, then win one with a conditional
update:

```ts
.where("id", "=", candidate.id)
.where("reserved_at", "is", null)   // ← the race guard
```

If another worker got there first the update matches zero rows and this
one tries the next candidate. SQLite serialises writers anyway, so there
is nothing row locks would buy.

Either way the read is **bounded** (`popBatchSize`, default 10) and
covered by the `(queue, available_at, id)` index. `pop()` runs several
times a second per worker, so an unbounded `SELECT *` here means every
worker reading and JSON-parsing the entire backlog on every poll.

That index's column order is deliberate, and it is about correctness as
much as speed. It has to satisfy `pop()`'s `ORDER BY available_at, id`,
because on MySQL a `... ORDER BY ... FOR UPDATE SKIP LOCKED` that needs a
**filesort locks every row it sorts**, so a second worker skips all of
them and gets nothing. Three workers polling a three-job queue would come
back with one job between them. If you add your own index here, keep
`available_at` ahead of anything else.

Timestamps are written truncated to whole seconds. These columns are
second-precision, and Postgres *rounds* rather than truncates, so a job
pushed with no delay was stored up to half a second in the *future* and
`available_at <= now` was false. The queue looked permanently empty.

#### Ordering

Jobs that are due at the same time are popped in the order they were
pushed. That is what the `id` half of `ORDER BY available_at, id` is for:
`available_at` only has second precision, so a fan-out dispatched inside
one second ties on it, and `id` is the only thing left to break the tie.

So `jobs.id` is a **snowflake** — a microsecond timestamp followed by a
counter — which sorts by the time it was minted. A random UUID would
make a burst run in an arbitrary order, which is not what a queue
described as FIFO should do.

This orders the *popping*, not the finishing. Several workers pop in
order and then run concurrently, so they complete in whatever order they
complete. Dispatch order is execution order only when a single worker is
draining the queue; if a sequence genuinely has to hold, use
[chaining](#chaining).

#### Transactions

Every statement resolves its connection at call time, `getActiveTransaction()
?? root`, exactly like `Model`, so a job pushed inside `DB.transaction()`
commits or rolls back *with* that transaction on every engine. See
[Dispatching inside a transaction](#dispatching-inside-a-transaction).

#### The rest

`release()` bumps `attempts`, clears `reserved_at`, and pushes
`available_at` out by the delay.

`fail()` inserts into `failed_jobs` and deletes the `jobs` row **in one
transaction**, so a crash between the two can't produce a duplicate
failed row or lose the job. It records the connection, the queue and the
chain alongside `error.stack ?? error.message`, which is what lets
`queue:retry` put the job back exactly where it came from with its chain
intact.

This driver also implements `FailedJobRepository`, which is what the
`queue:*` commands operate through.

### `fake`

Records every `push()` into an array and runs nothing. `QueueServiceProvider`
registers it alongside `sync` and `database`, so it's always available as a
connection name without any test-only wiring, point `queue.default` at
`"fake"`, pass `{ connection: "fake" }`, or let
`createTestApplication({ fakeQueue: true })` `swap()` it in.

```ts
const { queue } = await createTestApplication(bootstrap, { fakeQueue: true });

await request("POST", "/posts", { body: "hello" });

queue.assertPushed(LogPostCreatedJob);
queue.assertPushed(LogPostCreatedJob, (j) => (j.state.post as ModelReference).__id === post.id);
queue.assertNotPushed(SendWelcomeEmailJob);
queue.assertPushedTimes(LogPostCreatedJob, 1);
```

Every recorded push is a `PushedJob`:

```ts
interface PushedJob {
  jobClass: string;          // the registered name
  state: JobState;           // the serialized fields, models as { __model, __id }
  delaySeconds: number;      // 0 when dispatched without a delay
  chain: ChainedJob[];       // [] when unchained
  queue: string;             // "default" unless a queue was named
  afterCommit: boolean;      // true if it was deferred and the tx committed
}
```

| Method | Purpose |
|---|---|
| `pushed(job?, filter?)` | Matching pushes in dispatch order. All of them with no argument. |
| `hasPushed(job, filter?)` | Boolean. |
| `assertPushed(job, filter?)` | At least once. Throws on failure. |
| `assertNotPushed(job, filter?)` | Never. With a filter: no *matching* push. |
| `assertPushedTimes(job, times, filter?)` | Exactly `times`. |
| `assertPushedAfterCommit(job, filter?)` | Deferred until the transaction committed. |
| `assertNothingPushed()` | Nothing at all. |
| `reset()` | Discard recordings: for a `beforeEach()`. |

The fake honours `afterCommit` for real: it defers the *recording* the
same way a durable driver defers the push, so a test can assert that a
rolled-back transaction pushed nothing.

`job` is a `JobIdentifier`, either the registered name string or **the
class itself**. Prefer the class: it matches the dispatch site, survives a
rename, and a typo is a compile error rather than a silently-passing
`assertNotPushed()`. The class form needs a `JobRegistry`, which
`createTestApplication({ fakeQueue: true })` and the built-in `fake`
connection both supply. A bare `new FakeQueueDriver()` throws a message
saying so rather than quietly matching nothing.

Note `assertPushedTimes`, "this ran once, not twice" is exactly the shape
of a duplicate-dispatch bug, and it's the assertion `assertPushed()`
cannot make.

Assertions throw plain `Error`s, not vitest matchers, so the driver stays
runner-agnostic.

### Comparison

| | `sync` | `database` | `fake` | `redis` |
|---|---|---|---|---|
| Runs the job | inline | in a worker | never | in a worker |
| Persists | no | `jobs` table | no | Redis keys |
| Retries / backoff | no | yes | no | yes |
| Failed jobs | no | `failed_jobs` | no | a `:failed` hash |
| Reclaims a crashed worker's job | n/a | yes (`retryAfter`) | n/a | yes (`retryAfter`) |
| Named queues | n/a | yes | records them | yes |
| `afterCommit` | yes | yes | yes | no¹ |
| Multi-process | n/a | yes | n/a | yes |
| Needs a worker | no | yes | no | yes |

¹ The Redis driver has no database transaction to observe. Dispatch with
`{ afterCommit: true }` still works, `QueueManager` falls back to an
immediate push, but it does not defer. Use the `database` connection for
jobs that must not be visible before their rows are committed.

### `redis`

Four keys per named queue, all sharing a `{queue}` hash tag so a Redis
Cluster keeps them in one slot:

```
queues:{name}            list    ready jobs (LPUSH head, reserved from the tail)
queues:{name}:delayed    zset    scored by availability time (ms)
queues:{name}:reserved   zset    scored by RESERVATION EXPIRY (ms)
queues:{name}:failed     hash    failed jobs by id
```

The reserved set is a **zset scored by expiry**, not a list, precisely so
`pop()` can range-query it: every reservation older than `retryAfter`
gets pushed back onto the ready list with `attempts` incremented. That is
the same crash recovery the database driver gets from its `reserved_at`
predicate.

Every mutation is a **single Lua script**, reserve, release, fail, retry.
The alternative (`LREM` then `LPUSH` from the client) loses the job
outright if the worker dies between the two commands, which is exactly the
failure this driver exists to survive. Scripts are loaded once and invoked
by `EVALSHA`, with a transparent reload on `NOSCRIPT`, so a poll costs 40
bytes rather than a few kilobytes of script body.

This driver implements `FailedJobRepository`, so `queue:failed`,
`queue:retry`, `queue:forget` and `queue:flush` all work against it,
storing the full stack trace, the chain and the originating queue, same
as the database driver.

## Running a worker

```bash
./artisan queue:work
./artisan queue:work --connection database --queue emails
./artisan queue:work --sleep 1 --tries 5 --max-jobs 1000
./artisan queue:work --once
```

| Flag | Default | Meaning |
|---|---|---|
| `--connection <name>` | the configured default | Which connection to drain. |
| `--queue <name>` | the connection's own | Which named queue to drain. |
| `--sleep <seconds>` | `3` | How long to sleep when `pop()` returns nothing. |
| `--once` | off | Process a single job (or wait once) and exit. For tests and scripts. |
| `--tries <n>` | each job's `maxAttempts` | Override the attempt budget for every job. |
| `--timeout <seconds>` |: | Soft timeout for jobs that define no `timeout()`. |
| `--backoff <seconds>` | `attempts * 5` | Retry delay for jobs that define no `backoff()`. |
| `--memory <mb>` | `128` | Stop once heap usage crosses this. |
| `--max-jobs <n>` |: | Stop after this many jobs. |
| `--max-time <seconds>` |: | Stop after this long. |
| `--stop-when-empty` | off | Stop as soon as the queue drains (batch/CI runs). |

### Stopping is normal

Everything except `--stop-when-empty` and `--once` assumes the worker is
under a supervisor that restarts it. Stopping is how a worker picks up new
code after a deploy, and how a slow leak in one job gets bounded instead
of OOM-killing the host.

The loop traps `SIGINT` **and** `SIGTERM`. `SIGTERM` is what Docker and
Kubernetes send for graceful shutdown; trapping only `SIGINT` would leave
a containerised worker unable to finish an in-flight job before being
force-killed. On either signal the loop stops after the current job.

```bash
./artisan queue:restart
```

Tells every running worker to stop after its current job, the deploy
step, since workers hold their job classes in memory from boot and would
otherwise keep running the old code. It writes a timestamp to the cache;
each worker compares it with its own start time. **It needs a cache store
the workers share** (Redis across hosts); with the per-process array
store nothing else can see the signal.

```bash
./artisan queue:clear --queue emails
```

Deletes every pending job on a queue without running it. Destructive and
irreversible. The jobs are gone, not failed.

**Guarded in production** by the same check the migration commands use: it
prompts on a terminal (defaulting to *no*), and with no terminal it refuses
outright and exits non-zero. Pass `--force` to say you mean it. Outside
production it runs without asking.

### Named queues

One table (or Redis key space), many logical queues, so work can be
isolated and given its own workers:

```ts
await Bus.dispatch(new SendInvoiceJob(invoice), { queue: "emails" });
```

```bash
./artisan queue:work --queue emails    # a dedicated worker pool
```

A worker only ever sees the queue it was told to drain. A chained job
stays on the queue its predecessor ran on.

### Nothing takes the worker down

A `queue:work` process is a daemon, and anything that escapes the loop
both ends the process *and* leaves the in-flight job reserved until its
`retryAfter` elapses. So every failure has an explicit home:

| What happens | What the worker does |
|---|---|
| The job throws | Release with backoff, or fail once attempts run out. |
| The payload references a deleted model | **Fails the job**, logs, continues. |
| `pop()` throws (the DB went away) | Logs, sleeps, retries. |
| A `failed()` hook throws | Logs it. The failure is still recorded. |
| A lifecycle listener throws | Logs it. The job still completes. |

## The processing sequence

`processJob()` is a precedence list, and every branch matters. In order:

**1. Unknown job class → fail immediately.**

```ts
try {
  JobClass = registry.resolve(queued.jobClass);
} catch (error) {
  await driver.fail(queued, error as Error);
  return;
}
```

No retry. There is nothing sensible to retry. The class won't exist next
minute either. Straight to `failed_jobs`. This is how jobs orphaned by a
renamed registry key surface.

**2. Decode. A missing model goes one of two ways.**

```ts
if (error instanceof SkipJobMissingModelError) {
  await driver.delete(queued);   // deleteWhenMissingModels: true
  return;
}
await this.failJob(driver, queued, undefined, error);   // anything else
```

A `deleteWhenMissingModels` model that no longer exists means "this work
no longer applies": the job is removed successfully, not failed, not
retried, and `handle()` never runs.

Any other decode error, including the default `ModelNotFoundError` for a
row that was deleted while the job sat in the queue, **fails that job**
and the worker carries on. There is nothing to retry; the row will still
be missing next time.

**3. Attempts already exhausted → fail without running.**

```ts
if (queued.attempts >= maxAttempts) {
  await this.failJob(driver, queued, job, new MaxAttemptsExceededError(...));
  return;
}
```

A job reclaimed once too many after killing (or outliving) its workers
never threw, so nothing ever routed it to `failed_jobs`. Without this
check it cycles reserve → reclaim → reserve indefinitely.

**5. Run `handle()` through middleware, raced against `timeout()`.**

```ts
await runWithTimeout(runJobThroughMiddleware(this.app, job), job.timeout?.() ?? this.timeoutSeconds);
```

**6. Success → `delete` → `JobProcessed` → dispatch the next chain link.**

In that order. The job is removed from the queue *before* the event fires
and *before* the chain advances.

**7. `ReleaseJobError` → release with its delay, bounded by attempts.**

```ts
if (error instanceof ReleaseJobError) {
  if (queued.attempts + 1 >= maxAttempts) await this.failJob(driver, queued, job, error);
  else await driver.release(queued, error.delaySeconds);
  return;
}
```

A release isn't a failure. The work isn't wrong, it just shouldn't run
*now*. But `release()` bumps `attempts`, and a lock that is never free
would otherwise release the job forever. Bounding it by the same attempt
budget turns "spins indefinitely" into "fails, visibly, after N tries".

**8. Attempts exhausted OR `retryUntil()` passed → fail.**

```ts
const attemptsExhausted = queued.attempts + 1 >= maxAttempts;
if (attemptsExhausted || retryDeadlinePassed(job)) {
  await this.failJob(driver, queued, job, error as Error);
}
```

Order inside `failJob()`: `driver.fail()` (the row moves to
`failed_jobs`), then `job.failed()`, then `JobFailed`. Your `failed()`
hook runs *after* the job is already recorded as failed. It can't veto
that, and if it throws, that's logged rather than allowed to kill the
worker.

`maxAttempts` is `--tries` when the worker was given one, else the job's
own. A passed `retryUntil()` deadline wins over remaining attempts,
matching Laravel's precedence.

**9. Otherwise → release with backoff.**

```ts
const attempt = queued.attempts + 1;
const delay = job.backoff?.(attempt) ?? this.backoffSeconds ?? defaultBackoffSeconds(attempt);
await driver.release(queued, delay);
```

### Backoff

Both the custom and the default form receive the **1-based number of the
attempt that just failed**, so they agree:

| Failure | `queued.attempts` | `backoff()` receives | Default delay |
|---|---|---|---|
| 1st | `0` | `1` | `1 * 5` = **5s** |
| 2nd | `1` | `2` | `2 * 5` = **10s** |
| 3rd | `2` | `3` | `3 * 5` = **15s** |

(The default previously used the raw pre-increment count, making the first
retry immediate, which hammers a downstream that has just failed. It
doesn't any more.)

`--backoff <seconds>` sets a flat fallback for jobs that define no
`backoff()`; a job's own `backoff()` always wins.

### Queue events

```ts
export class JobProcessing extends AbstractEvent {
  constructor(connection: string | undefined, job: Job, queued: QueuedJob) { super(); }
}
```

`JobProcessing`, `JobProcessed`, and `JobFailed` (which also carries
`error`) are dispatched through [Events](../events/), but only when
`EVENTS_TOKEN` is bound. The queue package works standalone; events are a
soft dependency.

They are dispatched **defensively**:

```ts
try {
  await dispatcher.dispatch(event);
} catch (error) {
  this.app.logger.error("queue: job lifecycle listener threw", { error });
}
```

A listener that throws is logged and swallowed. An observer crashing must
never derail the worker or turn a successful job into a failed one.

```ts
listeners(): Array<[EventClass, ListenerClass]> {
  return [[JobFailed, ReportJobFailure]];
}
```

Note `connection` is `string | undefined`. It's whatever was passed to
`--connection`, so it's `undefined` when the worker is draining the
default.

## Job middleware

Middleware wraps the call to `handle()`, composed as a
[`@mahiframework/pipeline`](../helpers/) pipeline:

```ts
interface JobMiddleware {
  handle(
    passable: { app: Application; job: Job },
    next: (passable: { app: Application; job: Job }) => Promise<void>,
  ): Promise<void>;
}
```

With no middleware, `runJobThroughMiddleware()` is literally `await
job.handle()`, zero overhead for the common case. The same function is
used by the worker **and** the sync driver, so middleware behaves
identically under both.

The job arrives already rebuilt with models rehydrated.

### `ReleaseJobError`

```ts
throw new ReleaseJobError(delaySeconds);   // default 0
```

The control-flow sentinel meaning "put this back on the queue, try again
in `delaySeconds`", as distinct from a real failure. The work isn't
wrong; it just shouldn't run *right now*. Handled at step 6 above, before
any attempts logic.

### `RateLimited`

```ts
new RateLimited(limiter: RateLimiter, limiterName: string, releaseAfterSeconds = 0)
```

```ts
// once, at boot:
rateLimiter.for("emails", () => Limit.perMinute(30));

// on the job:
middleware(): JobMiddleware[] {
  return [new RateLimited(this.rateLimiter, "emails")];
}
```

Over the limit → `ReleaseJobError(Math.max(availableIn, releaseAfterSeconds))`,
so the retry is scheduled for roughly when the window frees up. Under it →
one `hit()` per limit, then `next()`. `Unlimited` limits are skipped
entirely.

**It fails open.** If no limiter is registered under that name, the
middleware calls `next()` and the job runs unthrottled, matching Laravel.
No error, no warning, a typo in the limiter name silently disables the
rate limit. Worth a test.

The limiter callback receives the **job instance**, so you can scope
per-tenant:

```ts
rateLimiter.for("exports", (job: ExportJob) => Limit.perMinute(5).by(job.tenantId));
```

The counter key is `` `${limiterName}:${limit.key || limit.fallbackKey()}` ``.

### `WithoutOverlapping`

```ts
new WithoutOverlapping(store: CacheStore | string | undefined, key: string, options?: {
  releaseAfterSeconds?: number | false;   // default 5
  expireAfterSeconds?: number;            // default 60
  shared?: boolean;                       // default false
})
```

```ts
middleware(): JobMiddleware[] {
  // explicit store:
  return [new WithoutOverlapping(this.cache.store(), `invoice:${this.invoice.id}`)];
}

middleware(): JobMiddleware[] {
  // resolve the default cache store from the container:
  return [WithoutOverlapping.for(`invoice:${this.invoice.id}`)];
}
```

The store can be a live `CacheStore`, a store *name*, or omitted
(`WithoutOverlapping.for(key)`) to resolve the default cache store from the
container (`CACHE_TOKEN`) at run time, so a job need not thread a store
through itself.

Fluent helpers mirror Laravel: `.releaseAfter(s)`, `.dontRelease()`,
`.expireAfter(s)`, `.shared()`.

Acquires a `Lock` on `overlap:<jobName>:{key}` with
`maximumWaitForSeconds: 0`, a **non-blocking** try-once. Waiting would tie
up the worker slot doing nothing.

**The key is namespaced by the job class** by default, so two unrelated
job classes using the same `key` (e.g. `"invoice:1"`) do NOT block each
other. Call `.shared()` (or pass `shared: true`) to lock purely on the key
across classes, Laravel's `WithoutOverlapping::shared()`, for
coordinating distinct job classes that touch the same resource.

`<jobName>` is the job's **registered** name, the same stable string
unique jobs key on, not `constructor.name`, which a minifier is free to
collapse onto a shared identifier, silently merging two classes' locks.
It falls back to `constructor.name` only when the registry cannot answer
(no queue provider installed, or an unregistered class): a lock key is
not worth failing a job over.

| `releaseAfterSeconds` | Behaviour when the lock is held |
|---|---|
| a number (default `5`) | `throw new ReleaseJobError(n)`: retry in `n` seconds. |
| `false` | `return`: the job is **silently dropped**. Laravel's `dontRelease`. |

The default is deliberately non-zero. A zero delay means the blocked job
is popped, finds the lock still held, and is released again immediately,
a hot loop burning a worker slot and a write per iteration for the whole
duration of the first job's run. The release also counts an attempt, so
the loop is bounded by `maxAttempts` regardless, but a sane delay is what
stops it being pathological in the first place.

The lock is released in a `finally`, so a throwing job still frees it.
`expireAfterSeconds` (default 60) is the auto-release safety net for a
crashed holder, set it above your worst-case runtime, or a long job loses
its lock mid-flight and a second copy starts.

A store failure (Redis unreachable) **propagates** rather than being read
as contention. Treating an outage as "someone else holds the lock" made
every job on every worker quietly release itself forever while the real
fault went unreported.

**The guarantee is only as strong as the store.** Backed by
`ArrayCacheStore` this prevents overlap within one process only, two
workers each get their own lock and both run. `FileCacheStore` covers
every worker on one host; only Redis covers workers on several. See
[Cache](../cache/#how-exclusive-is-a-lock-really).

### `ThrottlesExceptions`

```ts
new ThrottlesExceptions(limiter: RateLimiter, key: string, options?: {
  maxExceptions?: number;      // default 10
  decayMinutes?: number;       // default 1
  retryAfterSeconds?: number;  // default 0
})
```

A circuit breaker. More than `maxExceptions` failures within
`decayMinutes` and the circuit opens. Subsequent runs are released
**without executing `handle()` at all** until the window elapses, sparing
a failing downstream from being hammered by every retry.

```ts
middleware(): JobMiddleware[] {
  return [new ThrottlesExceptions(this.rateLimiter, `orders:${this.order.id}`, {
    maxExceptions: 10,
    decayMinutes: 5,
  })];
}
```

On the happy path the job runs normally. A thrown error is **counted and
re-thrown**, so the worker's own attempts/backoff/failed-jobs handling
still applies, the breaker only affects *future* runs once the threshold
is crossed. The counter key is `throttle-exceptions:{key}`.

## Failed jobs

`database` and `redis` both have durable failed-job storage.
`supportsFailedJobs(driver)` is the narrowing guard, and every command
below reports and exits when a connection doesn't support it (`sync`
rethrows at the dispatch site and records nothing):

```
The selected queue connection does not track failed jobs.
```

```ts
interface FailedJobRepository {
  listFailed(): Promise<FailedJobRecord[]>;
  findFailed(id: string): Promise<FailedJobRecord | undefined>;
  retry(id: string): Promise<boolean>;
  forget(id: string): Promise<boolean>;
  flush(olderThanHours?: number): Promise<number>;
}
```

```ts
interface FailedJobRecord {
  id: string;
  jobClass: string;
  payloadJson: string;   // as stored — parse it yourself
  error: string;         // the full stack trace when one was available
  failedAt: string;
  connection?: string;   // where it was running
  queue?: string;        // which named queue — where retry() puts it back
  chain?: ChainedJob[];  // the chain it was carrying, restored by retry()
}
```

### Commands

```bash
./artisan queue:failed
./artisan queue:failed --connection database
```

Lists `failed_jobs` newest first as an `ID / Job / Failed At` table.
Prints `No failed jobs.` when empty.

```bash
./artisan queue:retry <id> [<id>...]
./artisan queue:retry --all
```

Pushes each stored payload back onto the queue it failed on, with a
**fresh id**, `attempts` reset to `0`, and **its chain restored**, then
deletes the failed-jobs record, in one transaction, so a crash mid-retry
can't both requeue the job and keep the failed record. Reports
`No failed job with id {id}.` for an unknown id and keeps going.

Passing neither ids nor `--all` warns `No job ids given. Pass ids or --all.`

```bash
./artisan queue:forget <id>
```

Deletes one failed job without retrying it.

```bash
./artisan queue:flush
./artisan queue:flush --hours 168
```

Bulk-deletes failed jobs, or only those older than `--hours`. Reports how
many were removed. A non-numeric or negative `--hours` errors out rather
than deleting everything.

**Guarded in production**, like `queue:clear`. `failed_jobs` is the record
you read *after* an incident, so an unattended flush destroys evidence
rather than just rows. `--hours` narrows the range but does not remove the
need to confirm.

Every command takes `--connection <name>`, defaulting to the configured
default.

## Configuration

```ts
export function queueConfig(): QueueConfig {
  return {
    default: "sync",
    connections: {
      sync: {},
      database: { queue: "default", retryAfter: 90, afterCommit: true },
      redis: { queue: "default", retryAfter: 90 },
    },
  };
}
```

| Key | Default | Meaning |
|---|---|---|
| `queue` | `"default"` | The named queue this connection pushes to and works. |
| `retryAfter` | `90` | Seconds before a reserved job is presumed abandoned and reclaimed. |
| `afterCommit` | `false` | Hold every dispatch until the enclosing DB transaction commits. |
| `connection` | the app default | (`database` only) which *database* connection holds `jobs`. |
| `popBatchSize` | `10` | (`database` only) candidate rows read per poll on SQLite. |

**`retryAfter` must exceed the longest a job can run**, including its own
`timeout()`. Too low and a slow-but-healthy job gets a second worker
running it concurrently; too high and a genuinely crashed worker's job
waits that long to be retried. 90s suits most workloads, a queue of
long-running imports wants a higher value, and its own connection.

`QueueServiceProvider` also registers `fake` regardless of config.

Provider order: list it **after** `DatabaseServiceProvider`, because the
`database` connection resolves `DatabaseManager` from the container. If
`EventsServiceProvider` is registered, `QueueServiceProvider.boot()`
installs the queued-listener enqueue handler on the `EventDispatcher` and
registers the built-in `events.handle-queued-listener` job. See
[Configuration](../configuration/) and [Providers](../providers/).

## Queued event listeners

`dispatcher.listenQueued(EventClass, ListenerClass)` enqueues a listener
instead of running it inline. The plumbing is a built-in job,
`HandleQueuedListener`, registered under `events.handle-queued-listener`.
See [Events](../events/#queued-listeners).

## Production

```
# a worker, under a process supervisor that restarts it
./artisan queue:work --connection database --sleep 1 --max-time 3600
```

Run it under systemd, a Docker restart policy, or PM2, anything that
restarts the process when it exits. **The supervisor is not optional**:
`--max-time`, `--max-jobs`, `--memory` and `queue:restart` all work by
*exiting*, on the assumption something starts a replacement.

The worker exits on `SIGTERM`, which is what an orchestrator sends, so a
rolling deploy finishes the in-flight job cleanly.

Deploy step:

```bash
./artisan migrate
./artisan queue:restart     # workers pick up the new code
```

Workers hold their job classes in memory from boot, so without this they
keep running the old code indefinitely. `queue:restart` needs a cache
store the workers share, [Redis](../redis/) across hosts.

Scaling out means more worker processes, on as many hosts as you like:
reserving is atomic on both durable drivers, and a worker that dies has
its job reclaimed after `retryAfter` rather than stranding it. What does
**not** scale with them is `WithoutOverlapping` and `RateLimited` on the
**array** cache store, which is one `Map` per process and so guards
nothing once there are two workers. The `file` store covers every worker
on one host (its `add()` is an atomic `O_EXCL` create); across hosts, only
Redis does. See [Cache](../cache/#store-guarantees).

## Gotchas

**The constructor never re-runs.** Compute into fields, not locals.

**`maxAttempts` is not `tries`.** And its default lives on the prototype.

**`timeout()` doesn't stop anything.** The `handle()` promise keeps running
after the race rejects. JS cannot forcibly abort an in-flight `await`. So
a timed-out job may still be doing work while its retry runs. **Keep
`timeout()` well under `retryAfter`**, and make `handle()` idempotent.

**`retryUntil()` computed from `Date.now()` slides forever.** Capture the
deadline in a field.

**`await Bus.dispatch()` means "finished" under `sync` and "enqueued"
under `database`.** Code that reads the job's output right after
dispatching works in dev and breaks in production.

**Renaming a registry key orphans queued jobs.** They fail immediately as
an unknown class. Append, don't rename.

**A model field without `morphName` throws at dispatch**, not at run time.
That's the good case. You find out at the call site.

**`RateLimited` fails open** when the limiter name isn't registered.

**Delivery is at-least-once.** A job whose worker stalls past `retryAfter`
is reclaimed and runs again, concurrently with the original. Idempotent
`handle()` is not optional advice.

**`retryAfter` must exceed your slowest job.** Otherwise the recovery
mechanism becomes a duplicate-execution mechanism.

**Dispatching inside a transaction without `afterCommit` is a race.** The
worker can pop the job before the rows it references are committed. Turn
`afterCommit` on for the connection.

**`queue:restart` needs a shared cache store.** With the array store the
signal is per-process, so nothing else ever sees it.

**Middleware lock guarantees are per-store.** The `array` store doesn't
guard across workers at all; `file` guards across workers on one host,
`redis` across hosts.

**`queue:clear` is irreversible.** The jobs are deleted, not failed,
nothing records that they existed.

**A production command refused for want of a terminal exits 1.** That is
deliberate: a pipeline that forgot `--force` must fail rather than report
success for work that never happened. An operator answering "no" at a real
prompt exits 0. That is a decision, not a fault.

## Related

- [Cache](../cache/): the `RateLimiter` and `Lock` all three middleware build on
- [Events](../events/): queue lifecycle events, and queued listeners
- [Mail](../mail/): `Mail.queue()`, and why a credential must never be queued
- [Models](../models/): `morphName`, `deleteWhenMissingModels`
- [Scheduling](../scheduling/): `schedule.job(() => new SomeJob())`
- [Redis](../redis/): multi-process workers and cross-process locks
- [Providers](../providers/): the `jobs()` and `models()` hooks
- [Testing](../testing/): `createTestApplication({ fakeQueue: true })`
- [Configuration](../configuration/): `config/queue.ts`
