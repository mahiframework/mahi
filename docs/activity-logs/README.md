# Activity logs

`@mahiframework/activity-logs` records *what happened*, to one table,
discriminated by a `type` column:

| `type` | `model_*` is | Produced by |
|---|---|---|
| `resource` | the affected record | model lifecycle events, automatically |
| `security` | the user | auth events, automatically |
| anything else | whatever you say | `Activity.log()`, explicitly |

```ts
import { Activity } from "@mahiframework/activity-logs";

await Activity.log({
  type: "billing",
  action: "invoice_sent",
  model: invoice,
  data: { amount: invoice.total },
});
```

Not installed by default:

```bash
npm install @mahiframework/activity-logs
```

...then list the provider in `config/app.ts` **after**
`EventsServiceProvider`, `DatabaseServiceProvider` and
`AuthServiceProvider`, and **before** `HttpServiceProvider`:

```ts
EventsServiceProvider,
DatabaseServiceProvider,
AuthServiceProvider,
ActivityLogServiceProvider,   // ← here
// ...
HttpServiceProvider,
```

Every one of those is real: the provider contributes `listeners()` that
`EventsServiceProvider` collects, it owns a table, its actor lookup reads
the ambient auth scope, and its context pipe has to be collected before
routes are.

## Read this first: what is NOT recorded

An audit log that implies completeness it does not have is worse than one
that states its boundary. Model events are the boundary.

- **`EloquentBuilder` bulk writes are invisible.**
  `Post.query().where(...).update(...)`, `.delete()` and `.restore()`
  fire **no model events at all**, so nothing is logged. Same for the raw
  query builder.
- **`Model.update(id, values)` degrades.** That static fires `updated`
  with a plain attributes object rather than an instance, so there is no
  previous value to read. It records column names only, regardless of the
  configured capture mode, and flags the payload `partial: true`.
- **`Model.withoutEvents()` and `Event.suppress()` write nothing.** This
  is deliberate and useful: factories and seeders use the former, so they
  do not pollute the log.
- **`forceDelete()` on a soft-deleting model is recorded as
  `soft_deleted`.** The delete events carry nothing that distinguishes a
  force from a soft delete, and the in-memory instance is not updated by
  the soft-delete `UPDATE`, so `trashed()` reads `false` at exactly the
  wrong moment. Fixing it needs an additive change in
  `@mahiframework/database`.

If you need every write recorded without exception, that is a database
trigger or logical replication, not an application listener.

## The table

One table, `activity_logs`:

| Column | Notes |
|---|---|
| `id` | client-generated UUID, so an insert needs no `RETURNING` |
| `type` | `"resource"`, `"security"`, or yours |
| `action` | `"created"`, `"login"`, …; nullable |
| `model_type` | the subject's `morphAlias()` |
| `model_id` | the subject's key, as **text** |
| `user_id` | who did it; nullable |
| `message` | a short summary; nullable, truncated to 255 |
| `data` | JSON payload; nullable |
| `created_at` | no `updated_at`: a row is immutable |

`model_id` and `user_id` are text because they are polymorphic: they hold
the key of *any* model, and two models in one app can key differently (a
UUID `User`, a snowflake `Team`). Only text holds both.

There is deliberately **no subjectless row**. A nullable `model_type`
would make every read query branch, and the case it would serve is a log
line rather than an activity record.

Three indexes, one per real query: `(model_type, model_id, created_at)`
for "the history of this record", `(user_id, created_at)` for "what did
this user do", and `(type, action, created_at)` for "every failed login
in the last hour". Three indexes on a write-heavy table is a real cost;
an app that only ever reads by subject should drop the other two.

## Tracking models

Nothing is tracked until you say so, keyed by **morph alias** — the
string `Model.morphAlias()` returns:

```ts
// config/activity-logs.ts
export function activityLogsConfig(): ActivityLogConfig {
  return {
    resources: {
      Post: "full",
      User: { capture: "full", mask: ["phone"] },
      Invoice: { capture: "columns", actions: ["updated", "deleted"] },
      Session: "none",
    },
  };
}
```

Keyed by string, not by class, because a `config/*.ts` file is loaded
before `app.bootstrap()` and importing a model there pulls the ORM into
config-load time. It is also the same token the row stores.

**The cost is that a typo is silent.** `Posts: "full"` configures nothing
and looks exactly like working config. Run `activity-logs:check` in CI.

### Three capture modes

- **`"none"`** — writes a row with `data = null`. The event happened;
  what changed is not recorded. Right for a model where every column is
  sensitive, and **not** the same as omitting the model, which writes
  nothing at all.
- **`"columns"`** (the default) — names, never values.
  `{ attributes: ["title", "body"] }` on create,
  `{ changed: ["status"] }` on update.
- **`"full"`** — values, masked. `{ changes: { status: { from, to } } }`.

`"columns"` is the default deliberately: recording which fields moved is
useful and safe, recording their values is useful and not, so the
dangerous one should be the deliberate choice.

`only` and `except` filter which attributes are considered at all, before
masking.

## Masking

Three sources, unioned, all case-insensitive:

1. **The model's own `hidden`.** A model declaring `hidden: ["password"]`
   has already said that attribute does not leave the application.
2. **`config.mask`** — defaults to
   `["password", "password_confirmation", "secret", "token"]`.
3. **`resources[alias].mask`** — per model.

`visible` inverts rule 1, exactly as `toJSON()` does: when it is
non-empty, `hidden` is not consulted and only the listed attributes are
captured. Mirroring the framework's own serialisation is what stops a
model using `visible` from leaking through.

A masked attribute is **present with its value replaced**, never omitted:
`{ password: "[masked]" }`. Omitting it would make "this field changed"
unknowable, which is exactly what an audit wants to know about a password
column. Nested objects are walked to a bounded depth, so an `api_key`
inside a JSON column is masked too.

### Encrypted columns

**There is no encrypted cast in the framework**, so this package cannot
key masking off one. If you encrypt a column at the driver boundary, add
it to `hidden` or to `mask`. `activity-logs:check` warns on any `"full"`
capture for a model that declares neither, which is the closest available
safety net.

## Security events

Every `@mahiframework/auth` event is recorded automatically, through a
single registration on the abstract `AuthEvent` base — so events added to
auth later are picked up without a change here.

| Action | From |
|---|---|
| `login` / `logout` | `Login` / `Logout` |
| `password_incorrect` | `Failed` |
| `password_changed` | `PasswordReset` |
| `password_change_requested` | `PasswordResetLinkSent` |
| `email_verified` / `email_verification_sent` | the verification events |
| `email_changed` | a `ModelUpdated` on the user's email column |
| `token_created` / `token_revoked` | the token events |
| `sessions_revoked` | `CurrentDeviceLogout` / `OtherDeviceLogout` |
| `csrf_rejected` | `CsrfTokenMismatch` |

Two auth events are deliberately ignored. **`Authenticated`** fires on
every authenticated request, not once per login, so recording it would
write a row per API call and drown the table. **`Attempted`** fires for
both outcomes, and `Failed` already covers the half worth recording.

### Two blind spots inherited from auth

Neither is a bug here, and neither is fixable here.

**A failed login cannot say whether the account exists.** `attempt()`
returns `null` for both "no such account" and "wrong password",
deliberately, which is what keeps the account-enumeration oracle closed.
So `password_incorrect` carries the submitted address in `model_id` and in
`data.email`, and nothing more.

**A reset request for an unknown address is not recorded at all.**
`PasswordResetLinkSent` does not fire for one, because the response shape
hides that distinction and an event firing only for real accounts would
record exactly what the response conceals.

To detect an enumeration sweep, count requests at the route with
`throttle()` middleware.

### Impersonation

`user_id` stays the **impersonated** user: it is the account the action
was performed as, which is what "who did this" means in a record's
history. The admin behind it goes in `data.context`, seeded from
`Context`.

Note that `@mahiframework/impersonation` establishes a real session in
both directions, so starting and stopping an impersonation each dispatch
a `Login` — which this package records as a sign-in, twice. Pair the
activity log with `ImpersonationStarted`/`ImpersonationFinished` if that
distinction matters.

## Errors never fail the operation

Both listeners wrap their entire body and log failures through
`app.logger`. This matters because auth and model events are dispatched
**in-band and uncaught**: a throwing listener fails the `save()` or the
login that dispatched it. An audit row is important; it is not more
important than the thing it audits.

`throwOnFailure: true` inverts that, for a regime where an unloggable
action genuinely must not proceed. Off by default, and the consequence is
that a full disk takes your application down with it.

## Writes are synchronous, never queued

Three reasons, the first decisive:

1. **The data does not survive the trip.** The from→to pair is only
   readable between `syncChanges()` and `syncOriginal()` inside the
   `updated` dispatch. A queued listener's payload is a shallow spread
   with the constructor never re-run, so neither the model instance nor
   its `original` snapshot survives.
2. `listenQueued` has no pattern form.
3. The write is one INSERT with a client-generated id. Queueing it would
   trade that for a serialise, an insert into `jobs`, a poll, a
   deserialise and an insert — strictly more database work.

In-band also means a row shares the fate of what it records: an activity
row inside a rolled-back transaction rolls back with it, rather than
leaving a phantom "Post updated" for an update that never landed.

## Request metadata

`config.context` is a thunk merged into `data.context`. The package ships
a pipe that seeds `ip` and `user_agent` into `Context`:

```ts
context: () => Context.only(["ip", "user_agent", "request_id"]),
```

`request.ip()` is the socket peer, not `X-Forwarded-For`, unless
`trustProxies()` resolved one — and it is `undefined` under in-process
dispatch, so both values are optional and a missing one is omitted rather
than written as null.

`Context` does not survive into a queued job, so a job that writes an
activity log gets no IP. Correct: it had no request.

Set `context: false` to disable, or replace the thunk to carry a tenant
or a trace id. There are deliberately **no** `ip_address`/`user_agent`
columns: they would be two mostly-null columns on the highest-volume
table in the application.

## Reading the log

```ts
await ActivityLog.for(Post.morphAlias(), post.id).limit(50).get();
await ActivityLog.by(user.id).get();
await ActivityLog.ofType("security").get();
```

Pass `Post.morphAlias()` rather than a literal, so a later morph-map
change moves both sides at once.

**There is no list endpoint**, deliberately. Who may read an audit log,
how it is scoped, and whether `data` is exposed at all are decisions only
the application can make — and `data` can contain anything an app put
there. A route that exposed this table by default, with authorization you
had to remember to add, would be a hole rather than a feature.

## Suppressing

```ts
await Activity.without(() => importer.run());   // 50,000 rows, no logs
```

A package-local flag, not `Event.suppress()`: suppressing the underlying
events would also silence your own listeners on them, which is more than
you asked for.

## Commands

**`activity-logs:prune`** — deletes rows older than a retention window.

```bash
./artisan activity-logs:prune --days=90
./artisan activity-logs:prune --days=90 --dry-run
./artisan activity-logs:prune --type=resource --limit=50000
```

Not scheduled automatically: a retention window is a compliance decision,
and silently discarding audit history after 90 days because nobody
configured otherwise would be making it for you. Capped per run, because
the first prune on a never-pruned table can match millions of rows.

**`activity-logs:check`** — validates config against registered models.
Exits non-zero on an unmatched `resources` key, so it can gate CI.

## Gotchas

- **Bulk builder writes are invisible.** See the first section.
- **A typo in `resources` is silent.** Run `activity-logs:check`.
- **`"none"` is not the same as omitting the model.** The first writes a
  row with no payload; the second writes nothing.
- **`forceDelete()` on a soft-deleting model records `soft_deleted`.**
- **`Model.update(id, values)` can only record column names.**
- **An over-large `data` payload is replaced wholesale** by a
  `{ truncated: true, keys: [...] }` marker, not trimmed: a trimmed
  payload looks complete and is not.
- **Never configure `ActivityLog` as a resource.** The listener ignores
  it regardless — otherwise one write would recurse forever — and
  `activity-logs:check` errors on it.

## Related

- [Events](../events/): the dispatcher both listeners register with
- [Authentication](../authentication/): the auth events recorded here
- [Models](../models/): lifecycle events, `hidden`/`visible`, casts
- [Impersonation](../impersonation/): why a `Login` can mean two things
