import { describe, expect, it } from "vitest";
import { consoleWorkerArgs } from "../src/console-worker-args.js";

/**
 * The three-runtime re-exec table, which is the whole reason this
 * function exists. A long-running command that spawns a child of itself
 * has to build the right argv for whichever way the app was started, and
 * each of the three is wrong in a different way.
 *
 * `cwd` is pointed at a directory with no `node_modules/tsx` so the tsx
 * branch is exercised deterministically rather than depending on where
 * the suite runs from.
 */
const NO_TSX = "/nonexistent-for-tests";

describe("consoleWorkerArgs", () => {
  it("drops everything before the command for a compiled binary", () => {
    // A compiled binary IS the interpreter, and reports `argv[1]` as a
    // path inside its virtual filesystem. Passing that back would make
    // Commander read it as a subcommand and exit with `unknown command`.
    const argv = ["/usr/local/bin/myapp", "/$bunfs/root/myapp", "serve", "--port=80"];

    expect(consoleWorkerArgs("queue:work", ["--queue=mail"], argv, NO_TSX)).toEqual([
      "queue:work",
      "--queue=mail",
    ]);
  });

  it("keeps the built entry point for a compiled-js run", () => {
    const argv = ["/usr/bin/node", "/app/dist/bin/console.js", "serve"];

    // No tsx: a built `.js` entry loads natively.
    expect(consoleWorkerArgs("queue:work", [], argv, NO_TSX)).toEqual([
      "/app/dist/bin/console.js",
      "queue:work",
    ]);
  });

  it("falls back to the conventional entry point when argv names none", () => {
    expect(consoleWorkerArgs("queue:work", [], ["/usr/bin/node"], NO_TSX)).toEqual([
      "bin/console.ts",
      "queue:work",
    ]);
  });

  it("spawns a DIFFERENT command than the one running", () => {
    // The reason this is parameterised rather than reading argv: a
    // supervisor spawns its worker, and inheriting the parent's command
    // word would make the child supervise too — forever.
    const argv = ["/usr/bin/node", "/app/bin/console.js", "watchtower:work"];

    expect(consoleWorkerArgs("watchtower:worker", ["--process=xero"], argv, NO_TSX)).toEqual([
      "/app/bin/console.js",
      "watchtower:worker",
      "--process=xero",
    ]);
  });

  it("does not inherit the parent's flags", () => {
    const argv = ["/usr/bin/node", "/app/bin/console.js", "watchtower:work", "--once"];

    // `--once` belongs to the supervisor. Passing it to the child would
    // make every worker process exactly one job and exit.
    expect(consoleWorkerArgs("watchtower:worker", [], argv, NO_TSX)).toEqual([
      "/app/bin/console.js",
      "watchtower:worker",
    ]);
  });

  it("passes flags through in order", () => {
    const argv = ["/usr/bin/node", "/app/bin/console.js", "x"];

    expect(consoleWorkerArgs("w", ["--a=1", "--b=2"], argv, NO_TSX).slice(-3)).toEqual([
      "w",
      "--a=1",
      "--b=2",
    ]);
  });
});
