import { Command as CommanderProgram } from "commander";
import { runInvocationScope, type Application } from "@mahiframework/core";
import type { CommandClass } from "./command.js";
import { deriveProgramName, resolveRuntimeMode, type RuntimeMode } from "./runtime-mode.js";

export interface ConsoleKernelOptions {
  /**
   * What the CLI calls itself in `--help` and in Commander's errors. Defaults
   * to the basename of `argv[1]` (see `deriveProgramName()`), which is right
   * for a compiled binary and for `npx <app>`, and wrong for an app invoked
   * through a wrapper script with a different name. Those should pass this
   * explicitly.
   */
  name?: string;

  /** One-line description shown above the command list. */
  description?: string;

  /**
   * Enables `--version` / `-V`. Omitted, the flag does not exist and asking
   * for it is an error. Which is right for an app that has no meaningful
   * version, and wrong for anything distributed.
   */
  version?: string;

  /**
   * Force the runtime mode instead of detecting it. Mainly for tests; a real
   * app should let it be detected, or set `MAHI_MODE`.
   */
  mode?: RuntimeMode;

  /**
   * Whether `run()` calls `app.terminate()` when the command finishes.
   * Defaults to `true`, which is what makes a CLI process exit rather
   * than hang on an open database pool. See `run()`.
   *
   * Set `false` only when one Application outlives several `run()` calls
   * (a REPL, an in-process test harness), where terminating after the
   * first command would leave the rest running against closed
   * connections.
   */
  terminate?: boolean;
}

/**
 * Wraps Commander. Collects every provider's `commands()` hook and every
 * explicitly-registered built-in command, then registers each against the
 * Commander program. Provider command classes are instantiated fresh per
 * CLI invocation (with the booted Application passed to their constructor).
 *
 * The kernel is the SAME object in development and in a shipped binary. That
 * is the point, and it is why commands are written once. Only two things
 * differ between the two, both handled here: what the program calls itself,
 * and whether commands that only work inside a checkout are offered.
 */
/**
 * The name Commander will register, taken from a signature.
 *
 * A signature is `"name <required> [optional...]"`, so the name is everything
 * up to the first space.
 */
function commandName(signature: string): string {
  return signature.split(" ")[0] ?? signature;
}

export class ConsoleKernel {
  private program = new CommanderProgram();
  private commandClasses: CommandClass[] = [];
  private built = false;
  readonly mode: RuntimeMode;

  constructor(
    private app: Application,
    private options: ConsoleKernelOptions = {},
  ) {
    this.mode = options.mode ?? resolveRuntimeMode();

    // The name is set here from `process.argv` so that it is always populated,
    // and set AGAIN from the argv actually passed to `run()`. An explicit
    // `name` short-circuits both.
    this.program
      .name(options.name ?? deriveProgramName())
      .description(options.description ?? "Application CLI");

    if (options.version !== undefined) {
      this.program.version(options.version);
    }
  }

  /** Register a single command class directly (used for built-ins). */
  addCommand(commandClass: CommandClass): void {
    this.commandClasses.push(commandClass);
  }

  /** Collect `commands()` from every registered provider. */
  collectFromProviders(): void {
    for (const provider of this.app.getProviders()) {
      const classes = provider.commands?.();

      if (!classes) {
        continue;
      }

      for (const commandClass of classes) {
        this.addCommand(commandClass);
      }
    }
  }

  /**
   * The commands that will actually be registered, in order.
   *
   * A command declares `devOnly = true` when it cannot work outside a
   * checkout. It writes into the source tree (`make:*`), shells out to a
   * dev dependency (`test`), or re-executes the app through `tsx` (`serve`).
   * In `user` mode those are dropped rather than hidden, so that `--help`
   * lists nothing that would fail if it were typed.
   */
  registeredCommands(): CommandClass[] {
    const available =
      this.mode === "dev"
        ? [...this.commandClasses]
        : this.commandClasses.filter((CommandClass) => CommandClass.devOnly !== true);

    // Later registrations win, so an application can replace a framework
    // command by declaring one with the same name.
    //
    // Providers are collected in `config/app.ts` order, and the framework's
    // come first, so "later" means "the app's". Without this Commander throws
    // `cannot add command 'serve' as already have command 'serve'` and the app
    // does not boot AT ALL, not the command, the whole CLI, including
    // `--help`.
    //
    // The framework cannot know which names an application needs, which is
    // also why nearly every framework command is namespaced (`route:list`,
    // `queue:work`, `maintenance:down`): a framework that claims bare verbs
    // is one that dictates an app's primary interface. Namespacing makes a
    // collision unlikely; this makes one survivable.
    const byName = new Map<string, CommandClass>();

    for (const CommandClass of available) {
      byName.set(commandName(new CommandClass(this.app).signature), CommandClass);
    }

    return [...byName.values()];
  }

  /**
   * Throw instead of calling `process.exit()` on a parse error or `--help`.
   * Commander's default is fine for a real CLI and fatal in a test, which
   * would otherwise take the runner down with it.
   */
  exitOverride(): this {
    this.program.exitOverride();

    return this;
  }

  /**
   * The `--help` text, without running anything. Used by the dev/binary parity
   * check (5.6) to diff the two modes' command surfaces.
   */
  helpText(argv?: string[]): string {
    if (argv) {
      this.applyProgramName(argv);
    }

    this.build();

    return this.program.helpInformation();
  }

  /**
   * Name the program after the argv being parsed, not after the argv this
   * process happened to start with.
   *
   * They differ whenever argv is passed explicitly, most often in
   * tests, where deriving from `process.argv` yields the test runner's name
   * (`Usage: forks`) rather than the app's, and the derivation therefore goes
   * untested. An explicit `name` always wins.
   */
  private applyProgramName(argv: readonly string[]): void {
    if (this.options.name !== undefined) {
      return;
    }

    this.program.name(deriveProgramName(argv));
  }

  private build(): void {
    // `helpText()` and `run()` can both reach here; Commander would register
    // every command twice and print duplicates.
    if (this.built) {
      return;
    }

    this.built = true;

    for (const CommandClass of this.registeredCommands()) {
      const instance = new CommandClass(this.app);
      const sub = this.program
        .command(instance.signature)
        .description(instance.description)
        .action((...args: unknown[]) => instance.handle(...args));

      instance.configure(sub);
    }

    // `list`, an explicit command that prints the same help Commander shows
    // for `--help`, matching Laravel's `artisan list`. Registered here (not
    // as a `Command` subclass) because it needs the program itself.
    //
    // NOT registered as a bare `program.action()` default: giving the root
    // program its own action changes how Commander treats an unknown
    // subcommand (it routes to the default action instead of erroring), which
    // would make a typo'd command silently print help. Bare invocation is
    // handled in `run()` instead.
    //
    // Skipped when the application already registered a `list` of its own.
    // `registeredCommands()` dedupes by name precisely so an app can replace a
    // framework command, but this one is registered outside that map, so
    // without this guard an app owning the bare verb `list` (a task runner, a
    // package manager) makes Commander throw `cannot add command 'list' as
    // already have command 'list'` and the CLI does not boot AT ALL: not that
    // command, the whole binary, including `--help`.
    if (!this.program.commands.some((command) => command.name() === "list")) {
      this.program
        .command("list")
        .description("List all available commands.")
        .action(() => {
          this.program.outputHelp();
        });
    }
  }

  /**
   * Whether `argv` names no command at all (`./artisan` with nothing after
   * it). Commander's default for this is to print help and exit 1; a bare
   * invocation asking for help is not an error, so `run()` prints help and
   * returns 0 instead. Flags (`--help`, `--version`, `-x`) are left to
   * Commander.
   */
  private hasNoCommand(argv: readonly string[]): boolean {
    const operands = argv.slice(2);

    return operands.length === 0;
  }

  /**
   * Parse argv (defaults to process.argv) and run the matched command,
   * then terminate the application.
   *
   * Termination is in a `finally` and applies to every command, including
   * one that threw, because the failure mode it prevents is not
   * command-specific: any open pool or socket, MySQL, Postgres, Redis,
   * keeps Node's event loop alive, so a command that finishes its work
   * and returns leaves the process running with nothing to do. Measured:
   * `migrate` against MySQL never exited at all.
   *
   * Doing it here rather than in each command means a command author
   * cannot forget, and an application command gets the same treatment as
   * a framework one. `Application.terminate()` is idempotent, so a
   * command that terminates explicitly (`serve`, after its listener
   * closes) is not penalised for it.
   *
   * Set `terminate: false` in the kernel options for the rare embedder
   * that runs several commands against one long-lived application, a
   * REPL, a test harness driving the CLI in-process, where tearing the
   * app down after the first command would break the second.
   */
  async run(argv: string[] = process.argv): Promise<void> {
    this.applyProgramName(argv);
    this.build();

    // A bare `./artisan` (no command, no flags) prints help and exits 0.
    // The help is what the user asked for. Commander's own default would
    // print help and set exit code 1.
    if (this.hasNoCommand(argv)) {
      this.program.outputHelp();

      if (this.options.terminate !== false) {
        await this.app.terminate();
      }

      return;
    }

    try {
      // One command is one invocation: it gets an invocation id, a
      // Context overlay and a container scope, so its log lines are
      // correlatable and `scoped()` bindings resolve once rather than
      // per-`make()`. Wrapping the dispatch rather than each command
      // means a command author cannot forget, and an embedder driving
      // several `run()` calls against one long-lived Application gets a
      // distinct invocation per call instead of one shared forever.
      await runInvocationScope(this.app, () => this.program.parseAsync(argv));
    } finally {
      if (this.options.terminate !== false) {
        await this.app.terminate();
      }
    }
  }
}

/**
 * Render a failed command as ONE readable line, not the ~40-line
 * Kysely/driver stack a raw throw produces. The full stack is still
 * available on demand, set `DEBUG`, or pass `-v`/`--verbose`, for the
 * cases where the message alone is not enough.
 *
 * Exported so every entrypoint (`bin/console.ts`) renders a failed command
 * the same way, rather than each one re-deciding how much of the stack to
 * dump. Sets `process.exitCode = 1` as a side effect.
 */
export function renderConsoleError(error: unknown, argv: readonly string[] = process.argv): void {
  const message = error instanceof Error ? error.message : String(error);
  const verbose =
    process.env.DEBUG !== undefined || argv.includes("-v") || argv.includes("--verbose");

  console.error(`\nError: ${message}`);

  if (verbose && error instanceof Error && error.stack) {
    console.error(error.stack);
  }

  process.exitCode = 1;
}
