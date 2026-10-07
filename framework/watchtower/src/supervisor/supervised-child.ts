import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUIDv7 } from "node:crypto";
import { consoleWorkerArgs } from "@mahiframework/cli";
import type { Logger } from "@mahiframework/core";
import { PROCESS_ENV, RUN_ID_ENV, WORKER_ENV } from "../commands/watchtower-worker.js";

/** How many lines of a child's output to relay before summarising. */
const LINE_BUDGET = 10_000;

/**
 * One worker child: spawn it, prefix its output, know when it dies.
 *
 * Output is piped rather than inherited, which is the main departure from
 * `ServeCommand`. That command supervises exactly one child whose output
 * IS the command's output; with several, the lines have to be prefixed
 * (`[xero.2] …`) or they interleave into nonsense.
 *
 * Piping has a cost worth naming: a child that writes faster than this
 * process drains will block on its own stdout. Bounded by relaying at
 * most `LINE_BUDGET` lines and then counting, which turns "the supervisor
 * wedged" into "the supervisor stopped quoting a runaway worker".
 */
export class SupervisedChild {
  readonly runId: string;
  readonly startedAt = Date.now();

  private child?: ChildProcess;
  private linesRelayed = 0;
  private suppressed = 0;

  constructor(
    private readonly processName: string,
    private readonly index: number,
    private readonly logger: Logger,
  ) {
    this.runId = randomUUIDv7();
  }

  /** The label its output is prefixed with. */
  get label(): string {
    return `${this.processName}.${this.index}`;
  }

  /**
   * Start the worker.
   *
   * `spawn(process.execPath, …)` rather than `./artisan`: that is a bash
   * script, so it breaks on Windows and does not exist inside a compiled
   * binary. `consoleWorkerArgs()` owns the three-runtime argv table.
   *
   * `cwd` is passed explicitly because `base_path()` falls back to
   * `process.cwd()`, so a child inheriting a different one would resolve
   * a different database.
   */
  start(): void {
    const args = consoleWorkerArgs("watchtower:worker", [
      `--process=${this.processName}`,
      `--run-id=${this.runId}`,
    ]);

    this.child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // The recursion guard: a child must not supervise.
        [WORKER_ENV]: "1",
        [PROCESS_ENV]: this.processName,
        [RUN_ID_ENV]: this.runId,
      },
    });

    this.relay(this.child);
  }

  /** Whether the child is alive. */
  get running(): boolean {
    return (
      this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null
    );
  }

  get exitCode(): number | null {
    return this.child?.exitCode ?? null;
  }

  /** How long it has been alive, in milliseconds. */
  get uptimeMs(): number {
    return Date.now() - this.startedAt;
  }

  /** Ask it to stop after its current job. */
  signal(signal: NodeJS.Signals): void {
    if (this.running) {
      this.child?.kill(signal);
    }
  }

  /** Stop it now. For a child that ignored its shutdown window. */
  kill(): void {
    if (this.running) {
      this.child?.kill("SIGKILL");
    }
  }

  async waitForExit(): Promise<void> {
    if (this.child === undefined || !this.running) {
      return;
    }

    await once(this.child, "exit");
  }

  /** Resolves when the child exits, for a supervisor racing several. */
  whenExited(): Promise<void> {
    return this.waitForExit();
  }

  /**
   * Relay the child's output, line-prefixed.
   *
   * Split on newlines rather than relaying chunks, because a chunk
   * boundary falls mid-line and prefixing it would corrupt the output of
   * whichever worker was unlucky.
   */
  private relay(child: ChildProcess): void {
    for (const stream of [child.stdout, child.stderr]) {
      let buffer = "";

      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => {
        buffer += chunk;

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          this.write(line);
        }
      });
    }
  }

  private write(line: string): void {
    if (line === "") {
      return;
    }

    if (this.linesRelayed >= LINE_BUDGET) {
      this.suppressed += 1;

      // Reported once per thousand, so a runaway worker is visible
      // without becoming the runaway itself.
      if (this.suppressed % 1000 === 0) {
        this.logger.warning(
          `[${this.label}] suppressed ${this.suppressed} further lines (output budget reached).`,
        );
      }

      return;
    }

    this.linesRelayed += 1;
    this.logger.info(`[${this.label}] ${line}`);
  }
}
