# Console

`./artisan` is the CLI entrypoint. It boots the full application, every
provider registered and booted, the container populated, then hands
`process.argv` to a Commander program assembled from every registered
command class.

```bash
./artisan migrate
./artisan make:model Post --migration --factory
./artisan queue:work --once
./artisan --help
```

A command is a class with a `signature`, a `description`, and a
`handle()`. Providers contribute them through a `commands()` hook.

## The `./artisan` entrypoint

`artisan` is a **bash script**, not a TypeScript file:

```bash
#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if [[ -x "$DIR/node_modules/.bin/tsx" ]]; then
  TSX="$DIR/node_modules/.bin/tsx"
elif [[ -x "$DIR/../node_modules/.bin/tsx" ]]; then
  TSX="$DIR/../node_modules/.bin/tsx"
else
  echo "tsx not found (looked in node_modules/.bin). Run: npm install" >&2
  exit 1
fi

exec "$TSX" bin/console.ts "$@"
```

Three details, each a workaround for something real:

**It can't be a `#!/usr/bin/env -S npx tsx` shebang.** tsx's loader
activates based on the `.ts` file extension, not the shebang. An
extensionless TS file executed directly fails to transpile.

**It execs the locally installed `tsx`, not `npx tsx`.** `npx` may
download its own copy into `~/.npm/_npx`, whose module resolver does not
see this project's `node_modules/@mahiframework/*`. The `../node_modules`
fallback covers monorepos that hoist dependencies to the workspace root.

**It `cd`s to its own directory first.** Every path helper,
`base_path()`, `storage_path()`, `database_path()`, resolves against
`process.cwd()`, so `./artisan` from a subdirectory has to normalise cwd
or every path would be wrong. This is also why `./artisan test` picks up
the app's own `vitest.config.ts`.

`bin/console.ts` is four lines:

```ts
import { ConsoleKernel, CONSOLE_KERNEL_TOKEN } from "@mahiframework/cli";
import { bootstrap } from "./bootstrap.js";

const app = await bootstrap();
const kernel = app.make<ConsoleKernel>(CONSOLE_KERNEL_TOKEN);

kernel.collectFromProviders();
await kernel.run();
```

`bootstrap()` is shared with `bin/server.ts`, the same config, the same
providers, the same `await app.bootstrap()`. **A command runs against a
fully booted application**, so `this.app.make(...)` works for anything a
request handler could reach.

`pnpm console <command>` and `tsx bin/console.ts <command>` are
equivalent invocations.

## `ConsoleKernel`

```ts
class ConsoleKernel {
  constructor(app: Application);

  addCommand(commandClass: CommandClass): void;
  collectFromProviders(): void;
  run(argv?: string[]): Promise<void>;
}
```

A thin wrapper over [Commander](https://github.com/tj/commander.js).

| Method | Behaviour |
|---|---|
| `addCommand(Class)` | Queue a command class for registration. Used for built-ins. |
| `collectFromProviders()` | Call `commands()` on every registered provider and queue everything returned. |
| `run(argv = process.argv)` | Build the Commander program, then `parseAsync(argv)`. |

Registration is deferred: `addCommand()` only pushes the class onto a
list. Nothing is instantiated until `run()`, which builds every command
at once:

```ts
private build(): void {
  for (const CommandClass of this.commandClasses) {
    const instance = new CommandClass(this.app);
    const sub = this.program
      .command(instance.signature)
      .description(instance.description)
      .action((...args: unknown[]) => instance.handle(...args));

    instance.configure(sub);
  }
}
```

Note that **every** command class is instantiated on every CLI
invocation, not just the one you're running. Commander needs each
`signature` and `description` to build its help output and match argv. So
a `Command` constructor must be cheap. Do your work in `handle()`, and
resolve container services there too.

`ConsoleServiceProvider` binds the kernel with every built-in
pre-registered:

```ts
export class ConsoleServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(CONSOLE_KERNEL_TOKEN, (app) => {
      const kernel = new ConsoleKernel(app);
      for (const CommandClass of BUILT_IN_COMMANDS) {
        kernel.addCommand(CommandClass);
      }
      return kernel;
    });
  }
}
```

The built-ins in that list are the ones `@mahiframework/cli` owns, migrations,
`db:*`, `make:*`, `test`. Everything else (`serve`, `queue:work`,
`route:list`, `key:generate`) comes from its own package's provider via
the `commands()` hook.

## The `Command` base class

```ts
abstract class Command {
  abstract signature: string;
  abstract description: string;

  constructor(protected app: Application);

  configure(program: CommanderCommand): void;   // optional override
  abstract handle(...args: any[]): void | Promise<void>;
}

type CommandClass = new (app: Application) => Command;
```

Four members. `signature` and `description` are **fields**, not methods.

### `signature`: the name and its positional arguments

The signature string is passed straight to Commander's `.command()`, so
it uses Commander's syntax, not Laravel's:

| Signature | Meaning |
|---|---|
| `"migrate"` | No arguments. |
| `"db:table <table>"` | One **required** positional argument. |
| `"queue:retry [ids...]"` | An **optional variadic** positional argument. |
| `"test [args...]"` | Same: everything after the name, as an array. |

`<angle>` is required, `[square]` is optional, a trailing `...` makes it
variadic (an array). **Options and flags are not declared here**, that's
`configure()`'s job.

Signatures must be unique across every registered command. Registering
the same one twice makes Commander throw at startup, which is why a
provider must not re-export a command another provider already
contributes.

### `description`: the one-line help text

Shown in `./artisan --help`, and in `./artisan <name> --help`.

### `configure()`: flags and options

```ts
configure(program: CommanderCommand): void {
  program
    .option("-d, --dir <dir>", "Directory to write into", "src/models")
    .option("-m, --migration", "Also scaffold a create-table migration")
    .option("-f, --factory", "Also scaffold a model factory");
}
```

`program` is the raw Commander sub-command. `.option(flags, description,
defaultValue?)` is the workhorse:

| Form | Parsed as |
|---|---|
| `"--seed"` | boolean; `true` when present |
| `"--seed", "...", false` | boolean with an explicit default |
| `"--port <port>"` | **string**, required value |
| `"--hours <n>"` | still a string, `Number(options.hours)` yourself |
| `"--except <path...>"` | variadic; an array of strings |
| `"--no-reload"` | negated boolean; sets `reload: false` |
| `"-d, --dir <dir>"` | short and long alias for the same option |

**Option values are always strings.** Commander does no coercion, which
is why real commands do it by hand:

```ts
const sleepMs = Number(options.sleep) * 1000;
if (options.retry !== undefined) data.retryAfter = Number(options.retry);
```

`program.allowUnknownOption()` disables Commander's unknown-flag error.
`test` uses it so every argument passes through to vitest unparsed.

### `handle()`: the work

Commander calls `.action((...args) => instance.handle(...args))`, so the
arguments arrive in Commander's own order: **positional arguments first,
then the parsed options object**.

```ts
// signature = "migrate:fresh", one --seed flag
async handle(options: { seed: boolean }): Promise<void>

// signature = "db:table <table>"
async handle(tableName: string): Promise<void>

// signature = "make:model <name>", plus -d/-m/-f options
async handle(name: string, options: { dir: string; migration?: boolean; factory?: boolean }): Promise<void>

// signature = "queue:retry [ids...]", plus --connection/--all
async handle(ids: string[] = [], options: { connection?: string; all?: boolean }): Promise<void>
```

There is no type-level link between `signature`/`configure()` and
`handle()`'s parameters. You write the parameter types to match what you
declared. Getting them wrong is a runtime surprise, not a compile error.
Default the variadic parameter (`ids: string[] = []`) so calling
`handle()` directly from another command works.

`handle()` may be sync or async; `run()` awaits it either way.

### Calling one command from another

**There is no `this.call()` / `callSilently()`.** `Command` instances are
cheap, explicit-DI objects, not container-resolved singletons, so the
idiom is to construct and run the other command directly:

```ts
async handle(options: { seed: boolean }): Promise<void> {
  const ran = await runner.fresh(collectMigrationDirectories(this.app), (name, run) => Tui.task(name, run));

  if (ran.length === 0) {
    Tui.warning("Nothing to migrate.");
  }

  if (options.seed) {
    await new DbSeedCommand(this.app).handle();
  }
}
```

That's `migrate:fresh` calling `db:seed`, verbatim. A formal `call()`
wrapper would be sugar over `new X(this.app).handle(...)` and was
deliberately not built. The catch: you're calling `handle()` directly, so
you supply its arguments yourself and Commander's defaults don't apply.
Which is why defaulting them in the signature matters.

## The `commands()` provider hook

```ts
declare module "@mahiframework/core" {
  interface ProviderHooks {
    commands?(): CommandClass[];
  }
}
```

Declared by `@mahiframework/cli` via module augmentation, so a provider in any
package can implement it without core knowing about the CLI.

```ts
export class PostsServiceProvider extends ServiceProvider {
  commands() {
    return [PostSeedCommand];
  }
}
```

`collectFromProviders()` walks `app.getProviders()` in registration order
and queues everything returned. That's how each package contributes its
own:

| Provider | Commands |
|---|---|
| `ConsoleServiceProvider` | migrations, `db:*`, `make:*`, `test` |
| `HttpServiceProvider` | `route:list`, `maintenance:down`, `maintenance:up`, `serve` |
| `QueueServiceProvider` | `queue:work`, `queue:failed`, `queue:retry`, `queue:forget`, `queue:flush` |
| `ScheduleServiceProvider` | `schedule:run`, `schedule:list`, `schedule:test`, `schedule:work` |
| `CacheServiceProvider` | `cache:clear`, `cache:prune` |
| `EncryptionServiceProvider` | `key:generate` |
| `HealthServiceProvider` | `health` |
| `AuthServiceProvider` | `auth:gc` |

**Don't re-export a command another provider already contributes.**
Registering the same signature twice makes the kernel throw at startup.
Import it for the hook that needs it, and leave the registration alone:

```ts
// AuthGcCommand is imported for the schedule() hook below rather
// than re-registered via commands() — AuthServiceProvider already
// contributes it, and registering the same signature twice makes
// ConsoleKernel throw at startup.
import { AuthGcCommand } from "@mahiframework/auth";
```

## Built-in commands

Every command below, with its real signature and flags.

### Migrations

```bash
./artisan migrate                      # run all pending migrations
./artisan migrate:rollback             # roll back the most recent batch
./artisan migrate:status               # table of every discovered migration
./artisan migrate:fresh   [--seed]     # drop all tables, re-run everything
./artisan migrate:refresh [--seed]     # roll back every batch, then re-run everything
```

| Command | Signature | Flags |
|---|---|---|
| `MigrateCommand` | `migrate` |: |
| `MigrateRollbackCommand` | `migrate:rollback` |: |
| `MigrateStatusCommand` | `migrate:status` |: |
| `MigrateFreshCommand` | `migrate:fresh` | `--seed` (default `false`) |
| `MigrateRefreshCommand` | `migrate:refresh` | `--seed` (default `false`) |

All five resolve every migration directory in play via
`collectMigrationDirectories(app)`. The app's own
(`database.migrationsPath`, defaulting to `database/migrations`) plus
every provider's `migrations()` hook. That's how the `notifications`
table and the auth tables get migrated without appearing in your app's
directory.

`migrate`, `migrate:rollback` and both refresh variants render one
`Tui.task()` line per migration, so you get a live `RUNNING` → `DONE`
status per file. `migrate` prints `Nothing to migrate.` when there's
nothing pending; `migrate:fresh`/`migrate:refresh` print it as a
*warning*, since finding nothing after dropping everything is more
surprising.

`migrate:refresh` loops `rollback()` until it returns an empty batch,
then runs `up()`, so it walks back through *every* batch, not just the
last one.

### Database

```bash
./artisan db:seed                # run every seeder from every provider's seeders() hook
./artisan db:show                # driver + every table with column and row counts
./artisan db:table <table>       # column detail for one table
```

| Command | Signature | Notes |
|---|---|---|
| `DbSeedCommand` | `db:seed` | Walks `provider.seeders?.()`, one `Tui.task()` per seeder. |
| `DbShowCommand` | `db:show` | Kysely `introspection.getTables()` + a `countAll()` per table. |
| `DbTableCommand` | `db:table <table>` | Column name, type, nullability, auto-increment. |

`db:show` runs a `COUNT(*)` against every table, so it's slow on a large
database. `db:table` prints `Table "x" not found.` rather than throwing.

### Generators

Every `make:*` command takes `-d, --dir <dir>` with a sensible default,
and `-f, --force` to overwrite an existing file (without it, a generator
that would clobber something refuses and tells you to pass `--force`).

| Command | Default `--dir` | Filename written | Class suffix |
|---|---|---|---|
| `make:migration <name>` | `database/migrations` | `{timestamp}_{name}.ts` | — |
| `make:model <name>` | `src/models` | `{kebab}.model.ts` | — |
| `make:provider <name>` | `src` | `{Class}.ts` | `Provider` |
| `make:event <name>` | `src/events` | `{kebab}.event.ts` | — |
| `make:listener <name>` | `src/listeners` | `{kebab}.listener.ts` | — |
| `make:job <name>` | `src/jobs` | `{kebab}.job.ts` | `Job` |
| `make:seeder <name>` | `database/seeders` | `{kebab}.ts` | `Seeder` |
| `make:factory <name>` | `database/factories` | `{kebab}-factory.ts` | `Factory` |
| `make:policy <name>` | `src/policies` | `{kebab}.policy.ts` | `Policy` |
| `make:resource <name>` | `src/http/resources` | `{kebab}.resource.ts` | `Resource` |
| `make:request <name>` | `src/http/requests` | `{kebab}.request.ts` | `Request` |
| `make:controller <name>` | `src/http/controllers` | `{kebab}.controller.ts` | `Controller` |
| `make:middleware <name>` | `src/http/middleware` | `{kebab}.middleware.ts` | `Middleware` |
| `make:notification <name>` | `src/notifications` | `{kebab}.notification.ts` | `Notification` |
| `make:mail <name>` | `src/mail` | `{kebab}.mail.ts` | `Mail` |
| `make:command <name>` | `src/commands` | `{kebab}.command.ts` | `Command` |
| `make:test <name>` | `tests` | `{kebab}.test.ts` | — |

`make:model` takes four extra flags:

```bash
./artisan make:model Post --migration --factory
./artisan make:model Post -m -f
./artisan make:model Post --uuidv7 -m
```

| Flag | Effect |
|---|---|
| `-m, --migration` | Also runs `make:migration create_{table}_table` |
| `-f, --factory` | Also runs `make:factory {name}` into `database/factories` |
| `--uuid` | `id: string` + `keyType: "uuid"` (random v4) |
| `--uuidv7` | `id: string` + `keyType: "uuidv7"` (time-ordered) |

`-m`/`-f` work by constructing the other command directly,
`new MakeMigrationCommand(this.app).handle(...)`, the same
call-a-command-from-a-command idiom described above.

**`make:model`'s `--force` has no `-f` shorthand**, because `-f` is
`--factory` here. It is the one generator where that is true; every other
`make:*` takes `-f, --force`.

`--uuid` and `--uuidv7` are mutually exclusive and passing both is an
error. Omit them for the default DB auto-increment key. Whichever you
choose propagates to the migration and factory that `-m`/`-f` generate,
so all three files agree on one strategy — mixing them fails at
`create()` with a datatype mismatch. See
[Models](../models/#keytype-defaults-to-increment).

`make:migration` derives a table name from a `create_{x}_table` name and
puts it in the template; anything else gets a `"..."` placeholder.
`--create <table>` and `--table <table>` name it explicitly (a create or
an ALTER migration respectively). The timestamp prefix is local-time
`YYYYMMDDHHmmss`.

Class names go through `toClassName(name, suffix?)`, which is
`Str.studly(name)` plus the suffix **only when it isn't already there**
(case-insensitively). `make:job send-email` and `make:job SendEmailJob`
both produce `SendEmailJob`.

Templates are inline template-literal functions in each command. There
are no `.stub` files to publish or customise. If you want different
scaffolding, write your own `make:*` command; the `scaffold()` helper is
exported for exactly that:

```ts
import { scaffold, toClassName } from "@mahiframework/cli";

await scaffold({
  name,
  dir: options.dir,
  suffix: "Widget",
  template: (className) => `export class ${className} {}\n`,
  filename: (className) => `${Str.kebab(className)}.widget.ts`,
  label: "widget",
});
```

Generators print `Created {label}: {path}` via `console.log` and
overwrite an existing file without asking.

### Application key

```bash
./artisan key:generate
./artisan key:generate --force
./artisan key:generate --path .env.testing
```

| Flag | Default | Meaning |
|---|---|---|
| `-p, --path <path>` | `.env` | Which env file to write |
| `-f, --force` | `false` | Rotate an existing key |

Generates `base64:` + 32 random bytes and writes `APP_KEY=`.

**It refuses to overwrite an existing key without `--force`**, printing
`APP_KEY is already set in .env, leaving it unchanged. Pass --force to
rotate it.` Overwriting silently would make everything already encrypted
or hashed with the old key permanently unrecoverable.

`--force` only ever touches `APP_KEY`. It never writes
`APP_PREVIOUS_KEYS`. If old ciphertext must stay readable, copy the
outgoing key into `APP_PREVIOUS_KEYS` **before** rotating; the command has
no way to recover it afterwards. See
[Encryption](../encryption/).

### Queues

```bash
./artisan queue:work [--connection <name>] [--sleep <seconds>] [--once]
./artisan queue:failed  [--connection <name>]
./artisan queue:retry [ids...] [--connection <name>] [--all]
./artisan queue:forget <id> [--connection <name>]
./artisan queue:flush [--connection <name>] [--hours <n>]
```

| Command | Signature | Flags |
|---|---|---|
| `QueueWorkCommand` | `queue:work` | `--connection <name>`, `--sleep <seconds>` (default `"3"`), `--once` |
| `QueueFailedCommand` | `queue:failed` | `--connection <name>` |
| `QueueRetryCommand` | `queue:retry [ids...]` | `--connection <name>`, `--all` |
| `QueueForgetCommand` | `queue:forget <id>` | `--connection <name>` |
| `QueueFlushCommand` | `queue:flush` | `--connection <name>`, `--hours <n>` |

`queue:work` loops until interrupted, sleeping `--sleep` seconds when the
queue is empty. `--once` processes a single job (or waits once) and
exits, mainly for tests and scripts.

The four failed-job commands only work on a connection that tracks failed
jobs. Others report `The selected queue connection does not track failed
jobs.` and exit cleanly. See [Queues](../queues/) and
[Redis](../redis/).

### Scheduling

```bash
./artisan schedule:run             # run whatever is due right now — the cron entry
./artisan schedule:list            # every registered task, with its next due time
./artisan schedule:test            # interactively pick one task and run it
./artisan schedule:work [--once]   # foreground loop, evaluating once a minute
```

| Command | Signature | Flags |
|---|---|---|
| `ScheduleRunCommand` | `schedule:run` |: |
| `ScheduleListCommand` | `schedule:list` |: |
| `ScheduleTestCommand` | `schedule:test` |: |
| `ScheduleWorkCommand` | `schedule:work` | `--once` |

`schedule:run` is what a real crontab invokes every minute.
`schedule:work` is a **dev convenience**, a foreground loop polling once
a second and firing at most once per wall-clock minute. Unlike Laravel's
`schedule:work` there's no per-tick child process; tasks run in-process
through the same `runDueTasks()` path `schedule:run` uses.

`schedule:test` uses `Tui.select()` to pick a task, keying options by
index so two tasks sharing a description stay individually selectable.

See [Scheduling](../scheduling/).

### Health

```bash
./artisan health          # table of every registered check
./artisan health --json   # the exact payload GET /health serves
```

| Command | Signature | Flags |
|---|---|---|
| `HealthCommand` | `health` | `--json` |

Runs every check registered through a provider's `checks()` hook and
prints one row per check:

```
  Group   Check        Status
  core    cache        ✔ ok
  core    database     ✔ ok
  core    filesystem   ○ skipped
  app     stripe       ✘ Failed to connect

  4 checks, 1 failed (124ms)
```

Sets `process.exitCode = 1` if any check failed, so it works as a
deployment gate (`./artisan health || exit 1`). `--json` emits exactly
what the HTTP endpoint serializes, same object, same bytes, with no
ANSI codes, so it pipes into `jq` cleanly. Unlike the endpoint, the CLI
never redacts failure messages: it runs inside the trust boundary.

See [Health checks](../health/).

### HTTP

```bash
./artisan serve [--host <host>] [--port <port>] [--tries <count>] [--no-reload]
./artisan route:list
./artisan maintenance:down [--retry <seconds>] [--secret <secret>] [--message <message>] [--status <code>] [--except <path...>]
./artisan maintenance:up
```

| Command | Signature | Flags |
|---|---|---|
| `ServeCommand` | `serve` | `--host`, `--port`, `--tries` (default `"10"`), `--no-reload` |
| `RouteListCommand` | `route:list` |: |
| `DownCommand` | `maintenance:down` | `--retry`, `--secret`, `--message`, `--status`, `--except <path...>` |
| `UpCommand` | `maintenance:up` |: |

`serve` is the development server. Without `--no-reload` it forks a
**supervisor**: the parent watches `.env` (polling `mtime` every 500ms)
and respawns a worker child of the same command when it changes, printing
`Environment modified. Restarting server...`. `--no-reload` runs the
server directly in this process.

Port selection walks `--tries` alternate ports on `EADDRINUSE`, **unless**
the port came from `--port` or `SERVER_PORT`, an explicitly chosen port
is never silently changed. The resolution order is `--port` → a port
embedded in `--host` (`localhost:8080`, `[::1]:8080`) → `SERVER_PORT` →
`PORT` → `8000`.

The supervisor spawns the worker with `process.execPath` and
`tsx/dist/cli.mjs`, the real Node entry, not `node_modules/.bin/tsx`:

```ts
export function resolveTsxCli(cwd = process.cwd()): string | undefined {
  const candidates = [
    path.join(cwd, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(cwd, "..", "node_modules", "tsx", "dist", "cli.mjs"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}
```

The `.bin/tsx` file is a POSIX shim; spawning
`node <shim> console.ts` makes Node run `console.ts` natively, which
doesn't rewrite `.js` imports to `.ts` and fails with `Cannot find module
'.../bootstrap.js'`. Same monorepo-hoisting fallback as `./artisan`
itself.

`serve` is not for production. See [Deployment](../deployment/).

`route:list` prints a table of every registered route with the HTTP
method colour-coded (GET blue, POST/PUT/PATCH yellow, DELETE/ANY red,
HEAD/OPTIONS gray) and the route name in gray.

`maintenance:down`/`maintenance:up` toggle maintenance mode. `--secret`
sets a bypass value accepted as the `X-Maintenance-Secret` header or the
first path segment; `--except` lists paths that stay reachable.
`maintenance:up` prints `Application is already up.` when it wasn't down.

They are namespaced rather than Laravel's bare `down`/`up` because those
are two of the most useful verbs an application might want for its own
top-level interface, and a framework that claims them dictates that
interface. If an app does declare a command with a framework command's
name, the later registration wins (see
[the `commands()` hook](#the-commands-provider-hook)) rather than
breaking the CLI.

### Auth

```bash
./artisan auth:gc
```

Deletes expired sessions and expired password-reset tokens, logging both
counts through `this.app.logger`. Both stores enforce expiry on read, so
a stale row is never *honoured*, but nothing deletes them either, and
both tables grow without bound. It's a cleanup job, not a correctness
guarantee; schedule it.

### Tests

```bash
./artisan test
./artisan test --watch
./artisan test tests/todos.test.ts
./artisan test -t "creates a todo"
```

`signature = "test [args...]"` with `allowUnknownOption()`, so every
argument after `test` passes through **unparsed** to `npx vitest run
...`. It's a passthrough, not a reimplementation. It resolves whichever
vitest is in the invoking app's `node_modules` and uses that app's
`vitest.config.ts`. A non-zero exit sets `process.exitCode`.

## Output

Commands print through `@mahiframework/tui`, a from-scratch port of
`laravel/prompts` with no dependency on `@mahiframework/core` or the
container, so it's usable standalone and talks directly to
`process.stdin`/`process.stdout`.

`Command` exposes thin protected wrappers so you can write
`this.info(...)` instead of `Tui.info(...)`. Both are equivalent; use
whichever reads better.

| `Command` method | Forwards to | Laravel equivalent |
|---|---|---|
| `this.line(msg)` | `Tui.note` | `$this->line()` |
| `this.info(msg)` | `Tui.info` | `$this->info()` |
| `this.success(msg)` | `Tui.success` |: |
| `this.warn(msg)` | `Tui.warning` | `$this->warn()` |
| `this.error(msg)` | `Tui.error` | `$this->error()` |
| `this.table(headers, rows)` | `Tui.table` | `$this->table()` |
| `this.ask(label, opts?)` | `Tui.ask` | `$this->ask()` |
| `this.secret(label, opts?)` | `Tui.secret` | `$this->secret()` |
| `this.confirm(label, opts?)` | `Tui.confirm` | `$this->confirm()` |
| `this.choice(label, opts)` | `Tui.select` | `$this->choice()` |

`Tui` has more than `Command` wraps, `task`, `taskLine`, `spinner`,
`progress`, `intro`, `outro`, so use it directly when you need those.

### Tables

```ts
Tui.table(headers: string[], rows: (string | number)[][]): void
Tui.table(rows: (string | number)[][]): void
```

`route:list`, verbatim:

```ts
Tui.table(
  ["Method", "URI", "Name"],
  routes.map((r) => [colorizeMethod(r.method), r.path, r.name ? colors.gray(r.name) : ""]),
);
```

`db:table`:

```ts
Tui.table(
  ["Column", "Type", "Nullable", "Auto-increment"],
  table.columns.map((column) => [
    column.name,
    column.dataType,
    column.isNullable ? colors.yellow("yes") : "no",
    column.isAutoIncrementing ? colors.green("yes") : "no",
  ]),
);
```

Cells are `string | number`. ANSI colour codes inside a cell are handled
correctly by the width measurement, so colouring a cell doesn't break
alignment.

### Colours

```ts
import { colors } from "@mahiframework/tui";

colors.red("failed")
colors.green("ok")
colors.yellow("pending")
colors.gray("posts.show")
colors.bold(colors.blue("GET"))
```

Available: `bold`, `dim`, `italic`, `underline`, `inverse`,
`strikethrough`; `black`, `red`, `green`, `yellow`, `blue`, `magenta`,
`cyan`, `white`, `gray`; and `bgBlack` … `bgWhite`.

`migrate:status` uses them for status:

```ts
Tui.table(
  ["Migration", "Status"],
  statuses.map((s) => [s.name, s.ran ? colors.green(`Ran (batch ${s.batch})`) : colors.yellow("Pending")]),
);
```

### Tasks

```ts
Tui.task<T>(label: string, callback: () => T | Promise<T>): Promise<T>
Tui.taskLine(label: string, result: "done" | "failed" | "skipped", durationMs?: number): void
```

`task()` prints `label ......... RUNNING` while the callback is in
flight, then overwrites that line in place with the settled result:

```
  2026_08_21_create_posts_table ................................ 12ms DONE
  2026_08_22_create_likes_table ................................ 8ms DONE
```

`DONE` is green, `FAIL` red, `SKIPPED` yellow. The callback's return value
is passed through; a throwing callback prints `FAIL` and **rethrows**.
Under a non-interactive output (a CI log, a pipe) there's no `RUNNING`
flicker, just the settled line.

Every migration command uses it as the runner's progress callback:

```ts
const ran = await runner.up(collectMigrationDirectories(this.app), (name, run) => Tui.task(name, run));
```

as does `db:seed`:

```ts
await Tui.task(`Seeding: ${SeederClass.name}`, () => seeder.run());
```

`taskLine()` prints a single already-settled line with no `RUNNING`
state, for reporting an outcome you already know:

```ts
Tui.taskLine("Skipping: already imported", "skipped");
```

### Prompts

```ts
Tui.ask(label, options?): Promise<string>
Tui.secret(label, options?): Promise<string>
Tui.confirm(label, options?): Promise<boolean>
Tui.select<T>(label, options): Promise<T>
```

```ts
const name = await this.ask("Model name?", { required: true, placeholder: "Post" });
const token = await this.secret("API token?");
const ok = await this.confirm("Drop every table?", { default: false });
const env = await this.choice("Environment?", { options: ["local", "staging", "production"] });
```

| Option | On | Meaning |
|---|---|---|
| `default` | all | Pre-filled/pre-selected value |
| `placeholder` | `ask` | Greyed hint shown while empty |
| `required` | `ask`, `select`, `confirm` | `true`, or a custom message string |
| `validate` | all | `(value) => string \| undefined`; a string is the error |
| `transform` | `ask` | Post-process the submitted value |
| `hint` | all | A line of help below the prompt |
| `yes` / `no` | `confirm` | Custom labels |
| `scroll` | `select` | Visible options before scrolling. Default `5` |

`select`'s `options` is either a list (the value *is* the option) or a
record (key is the value, string is the display label). `schedule:test`
uses the record form to key by index:

```ts
const options: Record<string, string> = {};
tasks.forEach((task, index) => {
  options[String(index)] = task.getDescription();
});

const selected = await Tui.select("Which task would you like to run?", { options });
const task = tasks[Number(selected)]!;
```

Prompts need a TTY. A command that prompts unconditionally will hang or
misbehave in CI, guard with a `--force`/`--no-interaction` flag, the way
`key:generate` guards its overwrite.

### Spinners and progress bars

```ts
Tui.spinner<T>(message: string, callback: () => T | Promise<T>): Promise<T>

Tui.progress(label: string, total: number, options?: { hint?: string }): ProgressBar
Tui.progress<TItem, TResult>(
  label: string,
  items: TItem[] | Iterable<TItem>,
  callback: (item: TItem, bar: ProgressBar) => TResult | Promise<TResult>,
  options?: { hint?: string },
): Promise<TResult[]>
```

Two `progress()` forms. The mapping form is usually what you want:

```ts
const results = await Tui.progress("Importing", rows, async (row) => importRow(row));
```

The manual form hands you a `ProgressBar` you drive yourself
(`start()`, `advance(step = 1)`, `finish()`), for when the total is known
but the iteration isn't a simple map.

Use `spinner()` for indeterminate work and `task()` for a single labelled
step in a sequence.

## Signal handling

```ts
import { trap, type Signal } from "@mahiframework/cli";

function trap(signals: Signal | Signal[], callback: (signal: Signal) => void): () => void
```

Registers handlers and returns an `untrap()` that removes **exactly the
handlers this call registered**.

```ts
let running = true;
const untrap = trap(["SIGINT", "SIGTERM"], () => {
  running = false;
});

try {
  while (running) {
    await doWork();
  }
} finally {
  untrap();
}
```

That's `queue:work` and `schedule:work` verbatim. **Always `untrap()` in a
`finally`**, otherwise the listeners leak, and a long-lived process that
traps repeatedly will trip Node's max-listeners warning.

**Trap `SIGTERM`, not just `SIGINT`.** `SIGTERM` is what Docker and
Kubernetes send for graceful shutdown; trapping only `SIGINT` (Ctrl+C)
leaves a worker unable to finish an in-flight job before being
force-killed.

The pattern is always "flip a flag, let the loop notice", not "exit
now". That's what makes shutdown graceful: the current job finishes, the
loop condition fails, `finally` runs.

`trap` is a thin wrapper over `process.on(signal, cb)` / `process.off()`,
not a port of any real machinery. PHP needs `pcntl_signal()` plus a whole
handler-stacking layer to get this; Node's `process.on()` already *is* the
generic primitive.

## Writing a command, end to end

```ts
// src/console/commands/import-users.command.ts
import type { Command as CommanderCommand } from "commander";
import { Command, trap } from "@mahiframework/cli";
import { Tui, colors } from "@mahiframework/tui";
import { DatabaseManager, DATABASE_TOKEN } from "@mahiframework/database";
import { User } from "../../models/user.model.js";

interface Options {
  dryRun?: boolean;
  chunk: string;
}

export class ImportUsersCommand extends Command {
  signature = "users:import <file>";
  description = "Import users from a newline-delimited JSON file.";

  configure(program: CommanderCommand): void {
    program
      .option("--dry-run", "Parse and report without writing anything", false)
      .option("--chunk <n>", "Rows per transaction", "500");
  }

  async handle(file: string, options: Options): Promise<void> {
    const chunkSize = Number(options.chunk);
    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
      this.error(`Invalid --chunk value: "${options.chunk}".`);
      process.exitCode = 1;
      return;
    }

    const rows = await Tui.spinner(`Reading ${file}`, () => readNdjson(file));
    this.info(`Parsed ${rows.length} row(s).`);

    if (options.dryRun) {
      Tui.table(["Email", "Name"], rows.slice(0, 10).map((r) => [r.email, r.name]));
      Tui.taskLine("Dry run — nothing written", "skipped");
      return;
    }

    if (!(await this.confirm(`Import ${rows.length} users?`, { default: false }))) {
      this.warn("Aborted.");
      return;
    }

    const db = this.app.make<DatabaseManager>(DATABASE_TOKEN);

    let stopping = false;
    const untrap = trap(["SIGINT", "SIGTERM"], () => {
      stopping = true;
      Tui.warning("Finishing the current chunk, then stopping...");
    });

    let imported = 0;
    try {
      for (const chunk of chunked(rows, chunkSize)) {
        if (stopping) break;
        await Tui.task(`Importing ${chunk.length} users`, () =>
          db.transaction(async () => {
            for (const row of chunk) await User.create(row);
          }),
        );
        imported += chunk.length;
      }
    } finally {
      untrap();
    }

    this.success(`Imported ${colors.bold(String(imported))} user(s).`);
  }
}
```

Register it:

```ts
export class UsersServiceProvider extends ServiceProvider {
  commands() {
    return [ImportUsersCommand];
  }
}
```

```bash
./artisan users:import users.ndjson --chunk 1000
./artisan users:import users.ndjson --dry-run
```

The pieces, in the order they matter:

1. **`signature` declares positionals; `configure()` declares options.**
   `<file>` is required, `--dry-run`/`--chunk` are flags.
2. **`handle(file, options)`**: positionals first, options object last.
3. **Coerce option values yourself.** They're strings.
4. **Resolve services in `handle()`, not the constructor.** Every command
   class is constructed on every CLI invocation.
5. **Set `process.exitCode` on failure.** `handle()` returning normally
   is a success as far as Commander is concerned. Throwing produces a
   stack trace; a clean message plus `process.exitCode = 1` is usually
   better UX.
6. **Trap signals for long work, and `untrap()` in a `finally`.**
7. **Guard prompts.** `--dry-run` and `--force`-style flags are how a
   command stays usable in CI.

## Testing

`ConsoleKernel` takes an argv array, so a command is testable end to end
without a shell:

```ts
import { Application } from "@mahiframework/core";
import { ConsoleKernel, Command } from "@mahiframework/cli";

const calls: string[] = [];

class GreetCommand extends Command {
  signature = "greet <name>";
  description = "Say hello";
  handle(name: string) {
    calls.push(name);
  }
}

const app = new Application();
const kernel = new ConsoleKernel(app);
kernel.addCommand(GreetCommand);

await kernel.run(["node", "console", "greet", "Ada"]);

expect(calls).toEqual(["Ada"]);
```

The first two argv entries are ignored by Commander (it expects
`[execPath, scriptPath, ...]`), so any two placeholders work.

For output, `Tui.fake(keys)` swaps in a buffered output and a fake
terminal that yields keystrokes instead of reading stdin, public API,
mirroring `Prompt::fake([...])` in `laravel/prompts`:

```ts
import { Tui } from "@mahiframework/tui";

const tui = Tui.fake(["y", "\r"]);
try {
  await kernel.run(["node", "console", "users:import", "users.ndjson"]);
  expect(tui.strippedOutput()).toContain("Imported");
} finally {
  tui.restore();
}
```

`strippedOutput()` removes ANSI codes so assertions don't depend on
colour. `restore()` puts the real output and terminal back, always in a
`finally`.

For a command's logic in isolation, skip the kernel and call `handle()`
directly:

```ts
await new ImportUsersCommand(app).handle("users.ndjson", { chunk: "100", dryRun: true });
```

Remember Commander's option defaults don't apply on that path, supply
them yourself.

## Gotchas

**Every command class is constructed on every invocation.** Commander
needs each signature and description to build help. Keep constructors
cheap; resolve services in `handle()`.

**Duplicate signatures throw at startup.** Don't re-export a command
another provider contributes.

**Option values are strings.** `--hours 3` gives you `"3"`. Coerce and
validate.

**`handle()`'s parameters aren't type-checked against the signature.**
Positionals first, then options. Getting the order wrong is a runtime
bug.

**`--no-reload` sets `reload: false`, not `noReload: true`.** Commander's
negated-boolean convention. `serve` handles both because tests call
`handle()` directly.

**There is no `this.call()`.** `new OtherCommand(this.app).handle(...)`,
and you supply the arguments Commander would have defaulted.

**Prompts need a TTY.** A command that prompts unconditionally hangs in
CI.

**`untrap()` or leak listeners.** Always in a `finally`.

**Trap `SIGTERM` as well as `SIGINT`,** or orchestrated shutdowns kill
your worker mid-job.

**A thrown error from `handle()` surfaces as an unhandled rejection.**
There's no global command error handler. Catch, print, and set
`process.exitCode`.

**Generators overwrite silently.** No confirmation, no backup.

**Commands run against a fully booted app**, including every provider's
`boot()`. A command in an app whose `boot()` opens connections pays that
cost even for `./artisan --help`.

## Related

- [Migrations](../migrations/): `migrate:*`, `db:seed`, the `migrations()`/`seeders()` hooks
- [Queues](../queues/): `queue:work` and the failed-job commands
- [Scheduling](../scheduling/): `schedule:run` from a real crontab
- [Providers](../providers/): the `commands()` hook, registration order
- [Routing](../routing/): what `route:list` prints
- [Encryption](../encryption/): `key:generate`, `APP_PREVIOUS_KEYS`
- [Deployment](../deployment/): `serve` is not a production server
- [Testing](../testing/): `./artisan test`, and `Tui.fake()`
- [Installation](../installation/): the generated `bin/` layout
