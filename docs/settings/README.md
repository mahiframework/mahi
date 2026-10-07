# Settings

Global application settings that live in the database, are cached, and
are declared in code. A developer declares what each setting is called,
what it holds, what rules it obeys and what it is by default; authorised
users change the values at runtime.

```ts
import { Setting } from "@mahiframework/settings";

if (await Setting.get("import_feature_enabled")) {
  await importer.run({ batchSize: await Setting.get("import_batch_size") });
}

await Setting.set("import_batch_size", 250);
```

With the type augmentation below, `import_feature_enabled` is a
`boolean`, `import_batch_size` is a `number`, and a misspelled key is a
compile error.

## Settings are not config

`config/*.ts` is read from the environment at boot and is immutable at
runtime: it is where a deployment's shape lives (which database, which
cache store, which queue). A setting is the opposite — it changes while
the application is running, by somebody using it, and the change has to
outlive the process. If the value is set by an operator editing a file
and a redeploy, it is config. If it is set by an admin clicking a toggle,
it is a setting.

## Not installed by default

```sh
npm install @mahiframework/settings
```

Then add the provider to `config/app.ts`:

```ts
import { SettingsServiceProvider } from "@mahiframework/settings";

export const providers: ServiceProviderClass[] = [
  EventsServiceProvider,
  DatabaseServiceProvider,
  CacheServiceProvider,
  // ...
  SettingsServiceProvider,  // ← here
  // ...
  HttpServiceProvider,

  AppServiceProvider,
];
```

The ordering constraints:

- **After `DatabaseServiceProvider`** — the package owns a table and a
  model.
- **After `CacheServiceProvider`** — the settings map lives in a cache
  store.
- **After `EventsServiceProvider`**, if you listen for `SettingUpdated`.

Its position relative to the providers that *declare* settings does not
matter. `boot()` walks every registered provider, so a provider listed
later still has its definitions collected.

Then migrate:

```sh
./artisan migrate
```

## Declaring settings

Settings are declared by a provider's `settings()` hook. Anything
returned is collected at boot.

```ts
import { ServiceProvider } from "@mahiframework/core";
import { Rule } from "@mahiframework/validation";
import type { SettingDefinition } from "@mahiframework/settings";

export class AppServiceProvider extends ServiceProvider {
  settings(): SettingDefinition[] {
    return [
      {
        name: "import_feature_enabled",
        category: "import",
        description: "Allow users to start new imports.",
        type: "boolean",
        defaultValue: () => false,
      },
      {
        name: "import_batch_size",
        category: "import",
        description: "How many records each import batch processes.",
        type: "number",
        rules: () => Rule.make().min(1).max(1000),
        defaultValue: () => 100,
      },
    ];
  }
}
```

| Field | Required | Purpose |
|---|---|---|
| `name` | yes | Unique across the **whole application**, not per category |
| `type` | yes | How the value is stored, and what TypeScript type it is |
| `defaultValue` | yes | A thunk returning the value when no row exists |
| `category` | no | Grouping for an admin UI and `settings:list` |
| `description` | no | What it does, for an admin UI |
| `rules` | no | Extra constraints on top of the type |

### Names are globally unique

`category` is presentational. It groups settings in a UI and nothing
more — two settings in different categories may not share a name. Prefix
instead:

```ts
{ name: "import_feature_enabled" }   // good
{ name: "enabled", category: "import" }   // will collide eventually
```

A duplicate throws `DuplicateSettingError` at boot, rather than letting
one definition silently shadow another with a different type and default.

### `type` and `rules` do different jobs

`type` decides **storage** — how the value is encoded into the column and
decoded back out — and is what the TypeScript inference reads. `rules`
only **constrains** a value that is already of the right type. So a
definition never repeats its own type:

```ts
{
  name: "import_batch_size",
  type: "number",
  rules: () => Rule.make().min(1).max(1000),   // not `.number().min(1)`
  defaultValue: () => 100,
}
```

The type's own rule is prepended before validating. `rules` is optional;
omitting it validates the type and nothing else.

Both are thunks, deliberately. `Rule` is mutable — every chain call
pushes onto the instance — so a shared instance would accumulate steps
across validations. And an object or array default returned by reference
would be shared by every caller that read it, so one caller mutating it
would change the default for everyone.

> `exists()` and `unique()` are not usable in a setting's rules. Both
> throw rather than fail when no presence resolver is registered, and
> settings are read from CLI commands and queue workers where the
> database may not be booted.

### The types

| `type` | TypeScript | Stored as | Notes |
|---|---|---|---|
| `string` | `string` | JSON string | Not coerced; a number fails |
| `number` | `number` | JSON number | Coerces `"5"` → `5` |
| `boolean` | `boolean` | JSON boolean | Coerces `"on"`, `"1"`, `"true"` |
| `datetime` | `DateTime` | ISO 8601 string, UTC | Accepts a `DateTime`, `Date`, ISO string or epoch |
| `array` | `unknown[]` | JSON array | |
| `json` | `unknown` | JSON | Anything serialisable |

`number` and `boolean` coerce, which is what makes an HTML form post and
`settings:set` work without the caller parsing first. The coerced value
is what gets stored, so the normalisation is permanent rather than
re-done on every read.

A `datetime` is always normalised to UTC before storing. `toISOString()`
renders in the instance's own zone, so without that a value built in a
non-UTC zone would be read back as a different instant on two engines out
of three.

## Typed keys

The package exports an empty `AppSettings` interface for the application
to fill in:

```ts
declare module "@mahiframework/settings" {
  interface AppSettings {
    import_feature_enabled: boolean;
    import_batch_size: number;
  }
}
```

Put it anywhere that is part of the compilation — next to the provider
that declares the settings is the obvious place. With it:

```ts
await Setting.get("import_batch_size");        // number
await Setting.set("import_batch_size", 250);   // ok
await Setting.set("import_batch_size", "250"); // compile error
await Setting.get("import_batch_sze");         // compile error
```

The same mechanism `ProviderHooks` uses. It is the only way a
string-keyed registry can be type-safe: TypeScript cannot infer the
return type of `get("some_key")` from a definitions array it has not been
told about.

Augmenting is optional. With no augmentation, keys widen to `string` and
values to `unknown` — the package still works, it just checks nothing.
Nothing enforces that the augmentation matches the definitions, so keep
the two in step; the definitions are what validate at runtime.

## Reading and writing

```ts
await Setting.get("app_name");              // stored row, else the default
await Setting.all();                        // every declared setting + value
Setting.has("app_name");                    // is it DECLARED?
await Setting.isCustomised("app_name");     // is there a row?

await Setting.set("app_name", "Acme");      // validates, stores, invalidates
await Setting.setMany({ a: 1, b: 2 });      // all-or-nothing
await Setting.forget("app_name");           // delete the row → back to default
```

Resolution is two links: **the stored row, else the definition's
default.** There is deliberately no caller-supplied fallback — every
definition already carries a default, so a second one at the call site
could only disagree with it, and which won would depend on whether a row
happened to exist.

### An unknown key throws

On reads as well as writes. `UnknownSettingError` — because a typo is
otherwise indistinguishable from "nobody has customised this", which is
the one distinction declaring settings up front buys you. Use `has()`
when you genuinely do not know.

### There is no null

A setting is either stored or it is its default. "Unset" is expressed by
deleting the row:

```ts
await Setting.forget("app_name");   // not `Setting.set("app_name", null)`
```

A null standing in for "unset" would be a third state to reconcile
against the default on every read. `set(key, null)` fails validation.

`false`, `0`, `""` and `[]` are all perfectly good stored values and
round-trip as themselves — the value column holds JSON, not a bare
string, precisely so they do.

### Batches are all-or-nothing

`setMany()` validates every value before writing any, so a rejected field
in an admin form cannot leave the store half-updated. It is the right
call for a settings form:

```ts
// In a controller the application owns, after its own authorization check
await Setting.setMany(request.validated());
```

A failure throws `ValidationException`, which the HTTP error handler
already renders as a 422 with a per-field error bag. The error keys are
the setting names, so `import_batch_size` reports as "The import batch
size field must be at least 1" with no per-setting label to maintain.

## Who changed it

Every row carries `edited_by_user_id`. It is resolved from the ambient
auth scope by default:

```ts
await Setting.set("app_name", "Acme");          // the authenticated user
await Setting.set("app_name", "Acme", user);    // explicitly this user
await Setting.set("app_name", "Acme", null);    // deliberately unattributed
```

The tri-state matters: **omitting** the argument means "whoever is
authenticated right now", while an **explicit `null`** means "this was
not a user action". They are not the same thing.

A write from a seeder, a CLI command or a queue worker has no ambient
actor and stores `null` rather than throwing. This is deliberate and is
why the package reads `currentAuthState()` rather than `Auth.user()` or
`Auth.userOrNull()` — both of those throw `MissingAuthContextError`
outside a request scope, `userOrNull()` included.

The column is nullable `TEXT` with no foreign key: an app's user may key
on an int or a UUID, and the framework cannot assume the `users` table's
name.

## Authorization is yours

This package ships no routes, no controllers and no gate. `Setting.set()`
writes whatever it is given. Deciding who may call it is the
application's job:

```ts
export class UpdateSettingsController {
  async __invoke(request: Request) {
    await Gate.authorize("settings.manage");

    await Setting.setMany(request.validated());

    return response.json(await Setting.all());
  }
}
```

## Events

`SettingUpdated` fires once per changed setting, after the row is written
and the cache forgotten — so a listener that reads the setting back sees
the new value rather than racing the invalidation.

```ts
import { SettingUpdated } from "@mahiframework/settings";

export class DrainImportQueue implements Listener<SettingUpdated> {
  async handle(event: SettingUpdated): Promise<void> {
    if (event.key !== "import_feature_enabled") return;

    if (event.previous === true && event.value === false) {
      await queue.drain("imports");
    }
  }
}
```

`previous` is the setting's **effective** old value — the declared
default when nothing was stored, not a null standing in for one — so a
listener comparing the two sees the real transition. Both values are
decoded (a `DateTime`, not its ISO string).

Listeners are awaited inside the write, so a slow one slows the write. An
app with none can turn the dispatch off with `events: false`.

## Caching

The whole settings map lives under one cache key, with a 24-hour TTL by
default. Every write through the registry forgets it, and a model-event
listener covers writes that bypass the registry — a seeder calling
`SettingRecord.create()`, an admin screen going straight to the ORM.

One key rather than one per setting because `@mahiframework/cache` has no
tags: there is no flush-by-pattern, so every key this package writes is
one it must be able to name later. The table is a handful of rows, so
reading all of it is cheaper than the round trips to read a few.

The TTL is a backstop *because* invalidation is manual. If some path ever
escapes both mechanisms, a `null` TTL would make the stale map permanent.

> A failure to invalidate is **not** swallowed. A throw in the listener
> fails the write that triggered it. That is the opposite of the call
> `activity-logs` makes, and deliberate: a missing audit row is a lost
> record, but a cache still serving the old value is the application
> behaving contrary to its own configuration — a feature left on after
> being turned off. Better the write fails loudly and is retried.

## Configuration

Everything has a default, so `config/settings.ts` is optional:

```ts
import type { SettingsConfig } from "@mahiframework/settings";

export function settingsConfig(): SettingsConfig {
  return {
    cache: {
      key: "mahi.settings",
      store: undefined,   // the default store
      ttlSeconds: 86_400,
    },
    events: true,
  };
}
```

Wire it in `bin/bootstrap.ts`:

```ts
app.config.set("settings", settingsConfig());
```

## Commands

| Command | Does |
|---|---|
| `settings:list` | Every declared setting, its type, value, and whether it is customised |
| `settings:get <key>` | One value, bare and pipeable |
| `settings:set <key> <value>` | Parses against the declared type, validates, stores |
| `settings:forget <key>` | Deletes the row, reverting to the default |
| `settings:cache-reset` | Forgets the cached map |

```sh
./artisan settings:list --category=import
./artisan settings:list --customised --verbose

./artisan settings:set import_feature_enabled true
./artisan settings:set import_batch_size 250
./artisan settings:set allowed_domains '["a.test","b.test"]'

BATCH=$(./artisan settings:get import_batch_size)
```

`settings:get` writes the bare value to stdout with no indent, padding or
quotes, so `$(...)` captures the value and nothing else.

`settings:set` takes JSON for a `json` or `array` setting rather than a
comma-separated list — a setting whose values can contain commas would
otherwise have no way to say so. Its writes record a `null` actor, since
a command has no authenticated user and attributing it to one would be a
lie.

## Schema

```
settings    key                 string PRIMARY KEY
            value               text              -- JSON-encoded
            edited_by_user_id   string NULLABLE   -- TEXT, no FK
            created_at          timestamp
            updated_at          timestamp
```

`key` is the primary key: a setting has at most one row, so re-setting
overwrites rather than accumulating.

That is load-bearing rather than incidental. The obvious alternative for
per-user settings — a `(key, user_id)` unique index with `user_id`
nullable for globals — cannot be made portable: `nullsNotDistinct` is
Postgres 15+ only and *throws* on SQLite and MySQL, so two engines out of
three would permit unlimited duplicate rows for the same global setting.

**Per-user settings are out of scope.** If they are ever added they
belong in a second table with a composite `(key, user_id)` primary key,
where both columns are NOT NULL and the guarantee holds everywhere.

## When a definition's type changes

A stored value that no longer decodes under its definition's declared
type throws `SettingDecodeError` rather than falling back to the default
— a row saying one thing while the application reads another is a
configuration change nobody asked for. The error names the way out:

```sh
./artisan settings:forget import_batch_size
```

## Reference

Exports: `SettingsServiceProvider`, `SETTINGS_TOKEN`, `Setting`,
`SettingsRegistry`, `SettingRecord`, `SettingUpdated`,
`InvalidateSettingsCacheListener`, `display`, `resolveConfig`, the five
command classes, and the error family (`SettingsError`,
`UnknownSettingError`, `DuplicateSettingError`, `SettingDecodeError`).

Types: `AppSettings`, `SettingDefinition`, `SettingType`, `SettingKey`,
`SettingValue`, `SettingActor`, `InferSettingType`, `SettingsConfig`,
`SettingsCacheConfig`, `ResolvedSettingsConfig`,
`SettingRecordAttributes`.

`SettingsRegistry` is the service behind the facade, bound at
`SETTINGS_TOKEN`. It is keyed on `string` and returns `unknown` — the
typed narrowing lives on the `Setting` facade. Prefer injecting the
registry where threading it through is practical; use the facade where it
is not.
