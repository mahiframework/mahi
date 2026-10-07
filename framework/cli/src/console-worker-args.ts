import { existsSync } from "node:fs";
import path from "node:path";
import { isCompiledBinary } from "./runtime-mode.js";

/**
 * Path to `tsx/dist/cli.mjs`, the real Node entry, not
 * `node_modules/.bin/tsx`.
 *
 * The bin file is a POSIX shim; `spawn(process.execPath, [shim,
 * console.ts])` makes Node run `console.ts` natively, which does not
 * rewrite `.js` imports to `.ts` and fails with `Cannot find module
 * '.../bootstrap.js'`.
 */
export function resolveTsxCli(cwd = process.cwd()): string | undefined {
  const candidates = [
    path.join(cwd, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(cwd, "..", "node_modules", "tsx", "dist", "cli.mjs"),
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * The arguments to re-execute this application with, running `command`.
 *
 * For `spawn(process.execPath, consoleWorkerArgs("queue:work", ["--queue=x"]))`
 * — the portable way for a long-running command to start a child of
 * itself. Never spawn `./artisan`: it is a bash script, so it breaks on
 * Windows and does not exist inside a compiled binary.
 *
 * Three shapes, because `process.execPath` means something different in
 * each:
 *
 * | Running as | `execPath` | args |
 * |---|---|---|
 * | `./artisan x` (tsx) | `node` | `[tsx/cli.mjs, bin/console.ts, x, …]` |
 * | `node dist/bin/console.js x` | `node` | `[dist/bin/console.js, x, …]` |
 * | a compiled binary | the binary itself | `[x, …]` |
 *
 * The compiled case is the one that needs stating. Such a binary reports
 * `argv[1]` as a path inside its virtual filesystem
 * (`/$bunfs/root/<name>`) which does not exist on disk, so handing that
 * path back as an argument makes Commander see it as a subcommand name
 * and exit with `unknown command '/$bunfs/root/…'`. The binary
 * re-executes itself, so everything before the command word is dropped.
 *
 * `command` is explicit rather than taken from `argv`, which is what
 * makes this usable by a supervisor: `watchtower:work` spawns
 * `watchtower:worker`, a DIFFERENT command, so inheriting the parent's
 * own command word would make the child supervise too.
 */
export function consoleWorkerArgs(
  command: string,
  flags: readonly string[] = [],
  argv: readonly string[] = process.argv,
  cwd: string = process.cwd(),
): string[] {
  // A compiled binary IS the interpreter: `spawn(process.execPath, …)`
  // re-runs it, so it needs the command and its flags and nothing else.
  if (isCompiledBinary(argv)) {
    return [command, ...flags];
  }

  const scriptIdx = argv.findIndex(
    (arg) => arg.endsWith("console.ts") || arg.endsWith("console.js"),
  );
  const script = scriptIdx === -1 ? "bin/console.ts" : argv[scriptIdx]!;
  const rest = [script, command, ...flags];

  // `.ts` entry points need tsx to load them; a built `.js` one does
  // not, and handing tsx a `.js` file is merely redundant rather than
  // wrong.
  const tsxCli = script.endsWith(".ts") ? resolveTsxCli(cwd) : undefined;

  return tsxCli ? [tsxCli, ...rest] : rest;
}
