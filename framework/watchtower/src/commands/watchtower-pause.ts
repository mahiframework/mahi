import { Command } from "@mahiframework/cli";
import { WATCHTOWER_TOKEN } from "../tokens.js";
import type { WatchtowerManager } from "../watchtower-manager.js";

/**
 * Stop a process (or every process) reserving new jobs.
 *
 * In-flight jobs finish: a pause is about what to reserve NEXT, so
 * nothing is interrupted and nothing is left reserved. The workers stay
 * up and keep polling, which is what makes `watchtower:unpause`
 * instantaneous.
 *
 * The flag is a cache key, not a signal, for the reason `queue:restart`
 * gives: a deploy has no way to enumerate the PIDs of workers spread
 * across hosts, but every one of them can read one key. It therefore
 * needs a store the workers share — with the per-process array store
 * nothing else can see it, and this command says so rather than
 * reporting a false success.
 *
 * No TTL. A pause is an operator decision and must outlive any worker
 * that might be running, which has no upper bound.
 */
export class WatchtowerPauseCommand extends Command {
  signature = "watchtower:pause [process]";
  description = "Stop a watchtower process (or all of them) reserving new jobs.";

  async handle(processName?: string): Promise<void> {
    const watchtower = this.app.make<WatchtowerManager>(WATCHTOWER_TOKEN);

    // Resolved before writing, so a typo'd name is an error rather than
    // a key nothing ever reads.
    if (processName !== undefined) {
      watchtower.process(processName);
    }

    if (!(await watchtower.pause(processName))) {
      this.error(
        "No cache store is configured, so there is nowhere to record the pause. " +
          "Register CacheServiceProvider (and use a shared store such as redis) first.",
      );

      return;
    }

    this.info(
      processName === undefined
        ? "Paused every watchtower process. Workers stay up; in-flight jobs finish."
        : `Paused "${processName}". Workers stay up; in-flight jobs finish.`,
    );
  }
}
