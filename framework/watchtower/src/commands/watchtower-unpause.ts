import { Command } from "@mahiframework/cli";
import type { CommanderCommand } from "@mahiframework/cli";
import { WATCHTOWER_TOKEN } from "../tokens.js";
import type { WatchtowerManager } from "../watchtower-manager.js";

/**
 * Let a paused process (or every process) reserve again.
 *
 * Clears only the pause. A rate-limit cooldown is a SEPARATE key with its
 * own TTL, and clearing it is deliberately opt-in via `--clear-cooldown`:
 * a cooldown exists because an upstream service asked for one, so
 * cancelling it as a side effect of resuming a process would resume
 * hammering the API that asked to wait.
 */
export class WatchtowerUnpauseCommand extends Command {
  signature = "watchtower:unpause [process]";
  description = "Let a paused watchtower process (or all of them) reserve jobs again.";

  configure(program: CommanderCommand): void {
    program.option(
      "--clear-cooldown",
      "Also cancel an active rate-limit cooldown, which would otherwise expire on its own",
    );
  }

  async handle(processName?: string, options: { clearCooldown?: boolean } = {}): Promise<void> {
    const watchtower = this.app.make<WatchtowerManager>(WATCHTOWER_TOKEN);

    if (processName !== undefined) {
      watchtower.process(processName);
    }

    if (!(await watchtower.unpause(processName))) {
      this.error(
        "No cache store is configured, so there was nothing to clear. " +
          "Register CacheServiceProvider (and use a shared store such as redis) first.",
      );

      return;
    }

    if (options.clearCooldown) {
      const targets =
        processName === undefined
          ? watchtower.processes().map((process) => process.name)
          : [processName];

      for (const target of targets) {
        await watchtower.store().clearDeferral(target);
      }
    }

    this.info(
      processName === undefined ? "Resumed every watchtower process." : `Resumed "${processName}".`,
    );
  }
}
