# Watchtower

A supervised worker pool, a run history and a dashboard for your queues.
Horizon's job, in this framework's shape.

Three things, each independently useful:

- **A supervisor.** `watchtower:work` runs the worker processes you
  configure, restarts them when they die, backs off when they keep
  dying, and drains them gracefully on a deploy.
- **A run history.** Every attempt at every job, with the invocation id
  that joins it to your own log lines. Works on *any* queue driver.
- **A dashboard.** Opt-in, server-rendered, no build step. Behind a gate
  you define.

```sh
./artisan watchtower:work      # the supervisor
./artisan watchtower:status     # what every process is doing
./artisan watchtower:list       # throughput and failure rate per job
```

## Not installed by default

```sh
npm install @mahiframework/watchtower
```

Then add the provider to `config/app.ts`:

```ts
import { WatchtowerServiceProvider } from "@mahiframework/watchtower";

export const providers: ServiceProviderClass[] = [
  EventsServiceProvider,
  DatabaseServiceProvider,
  CacheServiceProvider,
  QueueServiceProvider,
  // ...
  WatchtowerServiceProvider,  // ← here
  // ...
  HttpServiceProvider,

  AppServiceProvider,
];
```

The ordering constraints:

- **After `QueueServiceProvider`** — a hard requirement. `register()`
  resolves the queue manager to add the `watchtower` connection.
- **After `DatabaseServiceProvider`** — the package owns four tables and
  two models.
- **After `CacheServiceProvider`** — pause, cooldown and heartbeat state
  lives in a cache store.
- **After `EventsServiceProvider`** — the run recorder is an event
  listener.
- **Before `HttpServiceProvider`**, if you enable the dashboard, so its
  routes are collected before the kernel captures its route table.

Then migrate:

```sh
./artisan migrate
```

## The run history works on its own

The most valuable half of this package needs none of the rest. Register
the provider, run the migration, and every job your app already runs —
on whatever queue connection it already uses — starts being recorded.

```sh
./artisan watchtower:list
```

```
Job type             Done    Failed  Rate    p50     p95     Throughput
SyncInvoiceJob       12,842  94      0.73%   842ms   4.2s    28.4/min
RefreshCustomerJob   8,106   12      0.15%   210ms   890ms   18.1/min
```

That answers a question `queue:failed` cannot: *which* job is the
problem. A job failing 2% of the time at high volume and one failing
every time at low volume produce similar-looking failure lists and very
different aggregates.

Adopt the supervisor and the dashboard when you want them. Nothing about
the history changes.

## Invocation ids are the point

Every run row carries two ids, and the distinction matters:

| | Scope | Use |
|---|---|---|
| `dispatchId` | one dispatch, stable across every retry | groups a retry chain into one story |
| `invocationId` | one attempt | joins that attempt to your log lines |

An invocation id is the id [every log line carries](../logging/#invocation-ids).
Paste one into your log aggregator and you get exactly that attempt's
output — which is the fastest route from "this job failed" to "here is
why".

```
./artisan watchtower:list --job=app.jobs.sync-invoice

dispatch 018f0e1a-...-8f31c
Attempt  Status     Duration  When      Invocation
1        failed     1.2s      16m ago   018f0e1a-...-ca80
2        failed     1.1s      9m ago    018f0e1a-...-cb21
3        completed  842ms     2m ago    018f0e1a-...-cc14
```

Three rows under one dispatch is "failed twice then succeeded", which
reads as one event. Three ungrouped failures read as three problems.

Note the grouping needs this package's own queue driver. Both core
drivers re-insert a row when retrying a failed job, so the key changes
and the chain cannot be reconstructed — the history is still correct per
attempt, just not grouped.

## Processes

A process is a named pool of workers draining a list of queues. It is
the unit of configuration, of scaling, and of throttling.

```ts
// config/watchtower.ts
import type { WatchtowerConfig } from "@mahiframework/watchtower";

export function watchtowerConfig(): WatchtowerConfig {
  return {
    processes: [
      { name: "default", queues: ["urgent", "default", "low"], workers: 3 },
      { name: "xero", queues: ["xero"], workers: 1, fifo: true },
      { name: "metrics", queues: ["watchtower-metrics"], workers: 1 },
    ],
  };
}
```

and in `bin/bootstrap.ts`, before the provider loop:

```ts
app.config.set("watchtower", watchtowerConfig());
```

**`queues` is ordered, highest priority first.** Each poll tries them in
order and takes the first job available. That is strict priority, not
weighted: a permanently busy `urgent` starves `default`, which is
sometimes exactly right and sometimes a mistake. Split the workload
across processes when it is a mistake.

**Two jobs that share a rate limit belong on one process**, so a cooldown
covers both. Two unrelated workloads belong on separate processes, so one
backing up cannot starve the other.

Every `queue:work` option a process accepts — `tries`, `timeout`,
`backoff`, `memory`, `maxJobs`, `maxTime`, `sleep` — means the same thing
it does there, and is passed to the workers. One file describes the
fleet.

## The supervisor

```sh
./artisan watchtower:work
```

Spawns `workers` children per process and keeps them running. What it
does beyond spawning:

**Restart backoff.** The first restart is immediate — the common cause is
a one-off, and making every blip cost a second of throughput would be the
wrong default. From the second consecutive failure the delay doubles, up
to a ceiling.

**Crash-loop surrender.** Past `crashLoopThreshold` exits inside the
window, that process is abandoned and the others keep running. A
supervisor that masks a startup crash by restarting forever is how a
deploy looks healthy and does nothing. `watchtower:work` exits non-zero
when every process has been abandoned — that is the signal for whatever
supervises *it*.

**Graceful drain.** On `SIGTERM` the signal is propagated to every child,
and they stop *after* their in-flight job rather than mid-way. Nothing is
interrupted and nothing is left reserved.

**It does not replace systemd or Kubernetes.** It supervises workers;
something still has to supervise it.

```ts
supervisor: {
  shutdownTimeoutSeconds: 30,         // budget for in-flight jobs
  restartBackoffCeilingSeconds: 60,
  crashLoopThreshold: 10,
  crashLoopWindowSeconds: 60,
}
```

## Strict ordering with `fifo`

A process that talks to a rate-limited service wants different behaviour
when it gets throttled. Consider a queue `A, B, C, D, E, F` where `A`
hits a 429 asking you to retry in 60 seconds.

Ordinarily, a release means *"retry this job in 60s, and run anything
scheduled before it in the meantime"* — so `B` through `F` run next, and
each one hits the same rate limit.

With `fifo: true`, the same release means *"pause this process for 60s
and retry this job before continuing with the others"*.

```ts
{ name: "xero", queues: ["xero"], fifo: true }
```

**Your job's code does not change.** It calls the same thing either way:

```ts
class SyncInvoiceJob extends Job {
  middleware() {
    return [new ThrottlesExceptions(10, 60)];
  }
}
```

or, by hand:

```ts
throw new ReleaseJobError(60);
```

The job cannot know whether it is on a `fifo` queue, a database queue or
`sync` — and should not. Whether a queue is strictly ordered is an
operational decision about the *queue*, so it is configuration, and the
same job runs correctly under both.

**The attempt is still spent.** A job that keeps being throttled still
fails once it exhausts `maxAttempts`, exactly as it would on an ordinary
queue. Being rate-limited is a reason this attempt did not complete, not
a free pass.

Two requirements, both enforced rather than silently ignored:

- **One worker.** A cooldown is process-wide, but a second worker can
  already hold the next job when the first releases, so ordering would
  not actually hold. `fifo` with `workers > 1` is a config error.
- **A shared cache store.** The cooldown is a cache key every worker
  reads. On the in-memory store it is per-process and does nothing, which
  would leave the process reserving jobs throughout what you believe is a
  backoff. Point the cache at Redis.

`maxDeferrals` (default 10) bounds how many times one job may pause its
process. Past it, releases revert to the ordinary form so one job cannot
hold the queue behind it indefinitely.

## Pausing

```sh
./artisan watchtower:pause            # every process
./artisan watchtower:pause xero       # one process
./artisan watchtower:unpause xero
```

Workers stay up and keep polling; they simply stop reserving. In-flight
jobs finish. Resuming is instant.

A pause and a rate-limit cooldown are separate, deliberately: a cooldown
exists because an upstream service asked for one, so `unpause` does not
cancel it. `--clear-cooldown` does, if you mean to.

```sh
./artisan watchtower:restart          # stop after the current job, for a deploy
```

`watchtower:restart` and `queue:restart` share one signal, so either
recycles both kinds of worker. An app running both wants one command that
recycles everything.

## The dashboard

Opt-in. Omit the `dashboard` key and no routes are registered at all.

```ts
dashboard: {
  prefix: "/watchtower",
  middleware: [authenticate("web")],
  pollSeconds: 5,
}
```

Three views — an overview, a failed-jobs list, and a per-job-type detail
page — served as one self-contained HTML document per request. No build
step, no bundler, no CDN, no asset files. A small inline script re-fetches
and replaces the page content every few seconds.

That last part is a rule rather than a preference. An operator opens this
on a bastion host with no egress, where a CDN-dependent page renders
unstyled exactly when it is needed most; and a third-party origin running
script in this page has access to every job payload on it.

### A gate is mandatory

```ts
// AppServiceProvider.boot()
import { Watchtower } from "@mahiframework/watchtower";

Watchtower.gate<User>((user) => user.isSuperadmin());
```

**Until you call this, nobody gets in.** Installing the package and
configuring `dashboard` grants nothing — every request is refused. An app
that forgets the gate gets a locked door rather than an open one, which
matters because the dashboard exposes job payloads and stack traces.

Call it once, from a provider's `boot()`. Calling it twice throws: there
is one answer to who may view the queue, and a silently-replacing
registry would make a stray second call a security change nobody
reviewed.

`middleware` is for **authentication** — establishing who the user is.
The gate is **authorization**, it runs after, and config cannot disable
it.

Deliberately not a `Gate` ability. `can("view-watchtower")` would read
better but would make `@mahiframework/authorization` a hard dependency,
and would interact with the permissions package's `before()` hook: an app
that happens to have a *permission* named `view-watchtower` would grant
dashboard access through a path nobody audited. If you want it routed
through the Gate, say so explicitly:

```ts
Watchtower.gate((user) => Gate.forUser(user).allows("view-watchtower"));
```

`watchtower:check` fails if the dashboard is configured with no gate.

### If your app sets a CSP

`http.securityHeaders.extra` overwrites rather than merges, so an
app-level `Content-Security-Policy` will break the dashboard's inline
script and the dashboard cannot defend itself. Allow `'unsafe-inline'`
(or a nonce) for its prefix.

### Your own UI instead

The dashboard is one consumer of a plain-data read API. If you would
rather render this in your own admin, ignore it and consume the data:

```ts
const stats = await Watchtower.stats();

stats.totals.pending;          // 1045
stats.processes[0].state;      // "running" | "paused" | "deferred" | "stopped" | "idle"
stats.queues[0].claimedBy;     // the process draining it, or null
stats.jobTypes[0].failureRate; // 0..1
stats.jobTypes[0].trend;       // completions per bucket, oldest first
stats.recentFailures[0].invocationId;
```

Raw numbers, not formatted strings, so you are not parsing them back.
`trend` is counts rather than percentages for the same reason: scale them
however your renderer wants, or label a bucket with the number.

A full read loads every run in the window for each job type, to compute
its percentiles in memory. That is fine per page view and wasteful on a
timer, so a polling UI should ask for the cached copy instead:

```ts
const stats = await Watchtower.cachedStats(5);
```

One read is shared by every caller for that many seconds, which is what
the bundled dashboard does with its own `pollSeconds`. `Watchtower.stats()`
is always live, so a command reporting state straight after changing it
cannot be served a stale answer.

`Watchtower.jobTypes()`, `Watchtower.jobType(name)` and
`Watchtower.recentFailures()` are the rest of it.

To keep the bundled dashboard but change how it looks, implement
`DashboardTheme` or subclass `DefaultDashboardTheme` and override one
method. Every piece of markup is a small protected method, and the
thirteen CSS custom properties in `:root` are the intended rebranding
seam.

```ts
dashboard: { theme: new MyDashboardTheme() }
```

## Storage

```ts
storage: "database",  // the default
```

Pending jobs live in `watchtower_jobs`, this package's own table — not
the core `jobs` table. The driver needs columns `jobs` does not have, and
adding them would be a breaking change to the queue package in service of
an optional one.

**A job dispatched on the `database` connection is invisible to
Watchtower, and vice versa.** Switching an app over means changing
`QUEUE_CONNECTION` and draining the old queue; no migration moves
in-flight rows.

`storage: "redis"` reuses `@mahiframework/redis`'s existing queue driver
unchanged. Faster, and it loses `fifo` and within-queue `priority`.

### Within-queue priority

A dispatch can order itself ahead of what is already waiting on the same
queue:

```ts
await Bus.dispatch(new SyncInvoiceJob(invoice), {
  connection: "watchtower",
  priority: 10,
});
```

Higher goes first; the default is `0`, and negative values sort behind it.
Ties fall back to FIFO, so a priority band is an ordering among bands
rather than a queue-jumping free-for-all within one.

**Only this package's driver honours it.** `priority` is declared on core
`PushOptions`, so it is accepted on every connection, but `database` and
`redis` both ignore it: `jobs` has no column to sort on and Redis's ready
set is a list with no cheap priority insert. A dispatch that depends on
the ordering therefore depends on `storage: "database"`.

Prefer separate queues and an ordered `queues` list when the priorities
are a fixed, small set — that works on every connection, and a process
draining `["urgent", "default"]` is easier to reason about than a spread
of integers. Reach for `priority` when the ordering is per-dispatch data
rather than a property of the workload.

Failed jobs go to `watchtower_failed_jobs`, and the queue CLI reaches
them through `--connection`:

```sh
./artisan queue:failed --connection=watchtower
./artisan queue:retry --connection=watchtower <id>
```

A retry preserves `dispatch_id`, so the retried attempt rejoins the same
history chain.

## Recording

```ts
recording: {
  enabled: true,
  queued: false,                   // inline by default
  queue: "watchtower-metrics",
  retentionDays: 7,
}
```

Inline costs three or four extra statements per job on the worker's hot
path. `queued: true` moves them off it, at the cost of the history
lagging and being lossy under load.

Inline is the default despite being slower, because queued needs a
process draining `queue` — and an app that configures nothing has none.
Defaulting to queued would record nothing and show an empty dashboard
with no error anywhere.

**The history is observability, not an audit log.** Under load the queued
path can drop a metrics job. Use
[activity logs](../activity-logs/) when the record must be complete.

**Pruning is mandatory.** The table grows by one row per job per attempt.

```ts
// A provider's schedule() hook
schedule.command("watchtower:prune").daily();
```

## Commands

| Command | Purpose |
|---|---|
| `watchtower:work` | The supervisor. `--process=a,b` for a subset, `--once` for CI |
| `watchtower:worker` | One child. An implementation detail of `watchtower:work` |
| `watchtower:status` | Process states, queue depths, recent failures |
| `watchtower:list` | Per job type: throughput, failure rate, p50/p95. `--job=` to drill in |
| `watchtower:check` | Validate config, the gate, and the resolved drivers |
| `watchtower:pause [process]` | Stop reserving. Workers stay up |
| `watchtower:unpause [process]` | Resume. `--clear-cooldown` to also cancel a backoff |
| `watchtower:restart` | Stop every worker after its current job |
| `watchtower:prune` | Trim run history to `retentionDays` |

Run `watchtower:check` in CI. It catches the things that are otherwise
silent: a queue nothing drains, `fifo` on an in-memory cache store, a
dashboard with no gate.

## Schema

```
watchtower_job_types     one row per job class ever seen
watchtower_job_runs      one row per attempt
watchtower_jobs          pending jobs (the queue)
watchtower_failed_jobs   failed jobs, retryable via the queue CLI
```

`watchtower_jobs.id` is auto-increment while the history tables use
UUIDv7, and the asymmetry is deliberate. The queue key is the FIFO
tiebreak: `available_at` has only second precision, so a burst dispatched
inside one second ties on it and the key alone decides the order. A
UUIDv7 is time-ordered only to the millisecond, and a tight dispatch loop
lands several inside one — reintroducing exactly the shuffle FIFO
promises not to have. The history tables are never ordered on their keys,
so a client-assigned id saves a round trip per insert.

## Limits

- **`watchtower_jobs` and `jobs` are separate queues.** No migration
  bridges them.
- **`fifo` means one worker**, needs a shared cache store, and is
  unavailable on `storage: "redis"`. So is within-queue `priority`, which
  is accepted on any connection but only acted on by this package's
  driver.
- **A job's `timeout()` is cooperative.** `retryAfter` must exceed the
  longest a job can take including its timeout, or a reclaim runs it
  concurrently with the original.
- **Delivery is at-least-once.** A reserved job whose worker dies is
  reclaimed with its attempt count incremented. Jobs must be idempotent.
- **Retry chains need this package's driver.** The core drivers change a
  job's key when retrying, so attempts cannot be grouped on them.
- **The dashboard polls**, so data is up to `pollSeconds` stale.
- **No auto-scaling.** `workers` is a fixed number.

## Reference

```ts
// Authorization — required for the dashboard
Watchtower.gate<User>((user) => boolean | Promise<boolean>)
Watchtower.hasGate(): boolean
Watchtower.allows(user): Promise<boolean>

// Reading
Watchtower.stats(windowHours?): Promise<WatchtowerStats>
Watchtower.cachedStats(ttlSeconds, windowHours?): Promise<WatchtowerStats>
Watchtower.jobTypes(windowHours?): Promise<JobTypeSummary[]>
Watchtower.jobType(name, windowHours?): Promise<JobTypeDetail | undefined>
Watchtower.recentFailures(limit?): Promise<JobRunSummary[]>

// Processes
Watchtower.processes(): readonly ResolvedProcessConfig[]
Watchtower.queues(): string[]
Watchtower.pause(process?): Promise<boolean>
Watchtower.unpause(process?): Promise<boolean>
Watchtower.workers(process): Promise<WorkerHeartbeat[]>
```
