import { Command, trap, type CommanderCommand } from "@mahiframework/cli";
import { Supervisor } from "../supervisor/supervisor.js";
import { WORKER_ENV } from "./watchtower-worker.js";
import { WATCHTOWER_TOKEN } from "../tokens.js";
import type { WatchtowerManager } from "../watchtower-manager.js";

/**
 * The supervisor: run the configured worker processes and keep them
 * running.
 *
 * This is what a service manager starts. It is NOT a replacement for
 * systemd or Kubernetes — it supervises workers, and something still has
 * to supervise it. Exiting non-zero after crash-loop surrender is the
 * signal to act on.
 *
 * Deliberately NOT `devOnly`. `ServeCommand` is, because it depends on
 * tsx being present; this must survive `bun build --compile`, so the
 * compiled-binary branch of `consoleWorkerArgs()` is the primary path.
 */
export class WatchtowerWorkCommand extends Command {
  signature = "watchtower:work";
  description = "Run and supervise the configured watchtower worker processes.";

  configure(program: CommanderCommand): void {
    program.option(
      "--process <name>",
      "Supervise only this process (repeatable via comma separation)",
    );
    program.option("--once", "Reconcile the pool once and exit, for tests and CI");
  }

  async handle(options: { process?: string; once?: boolean } = {}): Promise<void> {
    // The recursion guard. A worker child inherits this process's
    // environment, so without it a child would supervise, spawning
    // children that supervise, forever. The same mechanism
    // `SERVE_WORKER_ENV` provides for `serve`.
    if (process.env[WORKER_ENV]) {
      this.error(
        "watchtower:work was invoked inside a supervised worker. " +
          "Run `watchtower:worker` directly if that was intended.",
      );
      process.exitCode = 1;

      return;
    }

    const watchtower = this.app.make<WatchtowerManager>(WATCHTOWER_TOKEN);
    const selected = this.select(watchtower, options.process);

    if (selected.length === 0) {
      this.error("No watchtower processes are configured.");
      process.exitCode = 1;

      return;
    }

    const supervisor = new Supervisor(this.app, watchtower, selected);

    if (options.once) {
      await supervisor.tick();
      await supervisor.shutdown("SIGTERM");

      return;
    }

    let running = true;
    let shutdownSignal: NodeJS.Signals = "SIGTERM";

    // SIGTERM is what orchestrators send for a graceful stop. Trapping
    // only SIGINT would leave a containerised supervisor unable to drain
    // its workers before being force-killed.
    const untrap = trap(["SIGINT", "SIGTERM"], (signal) => {
      running = false;
      shutdownSignal = signal;
    });

    this.info(
      `Supervising ${selected.length} process(es): ` +
        selected.map((process) => process.name).join(", "),
    );

    try {
      await supervisor.run(() => running);
    } finally {
      untrap();
      // Propagated rather than killed: a worker stops after its
      // in-flight job, so nothing is interrupted and nothing is left
      // reserved.
      await supervisor.shutdown(shutdownSignal);
    }

    if (supervisor.surrendered) {
      // Non-zero so whatever supervises THIS process knows it gave up.
      // Exiting zero would let a deploy report success for a fleet that
      // is not running.
      process.exitCode = 1;
    }
  }

  private select(watchtower: WatchtowerManager, names?: string) {
    if (names === undefined) {
      return watchtower.processes();
    }

    // Resolved by name so a typo is an error rather than a supervisor
    // that silently runs nothing.
    return names
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "")
      .map((name) => watchtower.process(name));
  }
}
