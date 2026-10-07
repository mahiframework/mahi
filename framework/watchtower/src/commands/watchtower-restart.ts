import { Command } from "@mahiframework/cli";
import { signalRestart } from "@mahiframework/queue";

/**
 * Tell every running worker to stop after its current job, so the
 * supervisor starts replacements running the new code.
 *
 * Delegates to `@mahiframework/queue`'s own restart signal rather than
 * inventing a second mechanism, which means `queue:restart` and
 * `watchtower:restart` stop each other's workers. That is intentional: an
 * app running both kinds of worker wants one command that recycles
 * everything, and two independent signals would leave half the fleet on
 * old code after a deploy.
 *
 * Signalling beats killing: a worker stops BETWEEN jobs, so nothing is
 * interrupted and nothing is left reserved. The signal is read once at
 * startup and compared against the worker's own start time, so a restart
 * recorded after a worker booted means that worker is running stale code.
 */
export class WatchtowerRestartCommand extends Command {
  signature = "watchtower:restart";
  description = "Tell running watchtower workers to stop after their current job.";

  async handle(): Promise<void> {
    if (!(await signalRestart(this.app))) {
      this.error(
        "No cache store is configured, so there is nowhere to record the restart signal. " +
          "Register CacheServiceProvider (and use a shared store such as redis) first.",
      );

      return;
    }

    this.info("Broadcasting restart signal. Workers will stop after their current job.");
  }
}
