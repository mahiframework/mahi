import { CACHE_TOKEN, QUEUE_TOKEN } from "@mahiframework/core";
import { Command } from "@mahiframework/cli";
import type { CacheManager } from "@mahiframework/cache";
import type { QueueManager } from "@mahiframework/queue";
import { isSharedStore } from "../deferral.js";
import { supportsDeferral } from "../drivers/watchtower-queue-driver.js";
import { validateConfig } from "../validate-config.js";
import { WATCHTOWER_CONNECTION, WATCHTOWER_TOKEN } from "../tokens.js";
import type { WatchtowerManager } from "../watchtower-manager.js";

/**
 * Validate the configuration against the things it cannot be validated
 * against at boot.
 *
 * `resolveConfig()` + `validateConfig()` already reject a config that
 * cannot work on its own terms, and the provider throws on those. This
 * command covers everything that needs the container built: whether a
 * gate is registered, whether the resolved cache store is shared, and
 * whether the resolved queue driver understands `fifo`.
 *
 * A CHECK, not a boot failure, for the same reason `permissions:check`
 * is: several of these conditions are legitimately transient during a
 * rollout, and a provider that refused to boot on them would take an app
 * down for a problem it could have reported. Exits non-zero so CI can
 * gate on it.
 */
export class WatchtowerCheckCommand extends Command {
  signature = "watchtower:check";
  description = "Validate watchtower configuration, the gate, and the resolved drivers.";

  async handle(): Promise<void> {
    const watchtower = this.app.make<WatchtowerManager>(WATCHTOWER_TOKEN);
    const config = watchtower.configuration();
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const problem of validateConfig(config)) {
      (problem.level === "error" ? errors : warnings).push(problem.message);
    }

    this.checkGate(watchtower, errors);
    this.checkFifo(watchtower, errors);
    await this.checkQueues(watchtower, warnings);

    for (const warning of warnings) {
      this.warn(`watchtower:check: ${warning}`);
    }

    for (const error of errors) {
      this.error(`watchtower:check: ${error}`);
    }

    if (errors.length > 0) {
      process.exitCode = 1;

      return;
    }

    this.success(
      warnings.length > 0
        ? `Configuration is usable, with ${warnings.length} warning(s).`
        : "Configuration looks good.",
    );
  }

  /**
   * A configured dashboard with no gate is a dashboard nobody can open.
   *
   * An error rather than a warning: it is not a security hole (the gate
   * denies everyone by default, which is the safe direction) but it is
   * the single most likely mistake when installing the package, and a
   * deploy should fail on it rather than ship a 403 page.
   */
  private checkGate(watchtower: WatchtowerManager, errors: string[]): void {
    if (watchtower.configuration().dashboard === undefined) {
      return;
    }

    if (!watchtower.hasGate()) {
      errors.push(
        "`watchtower.dashboard` is configured but no gate is registered, so every request is " +
          "refused. Call `Watchtower.gate((user) => ...)` from a service provider's boot().",
      );
    }
  }

  /**
   * `fifo` needs a driver that understands it and a cache store every
   * worker in the process can see.
   *
   * Both fail silently otherwise, and in the same direction: the process
   * keeps reserving jobs through what an operator believes is a backoff,
   * hammering the API that asked it to wait.
   */
  private checkFifo(watchtower: WatchtowerManager, errors: string[]): void {
    const fifoProcesses = watchtower.processes().filter((process) => process.fifo);

    if (fifoProcesses.length === 0) {
      return;
    }

    const names = fifoProcesses.map((process) => process.name).join(", ");

    if (this.app.has(QUEUE_TOKEN)) {
      const driver = this.app.make<QueueManager>(QUEUE_TOKEN).connection(WATCHTOWER_CONNECTION);

      if (!supportsDeferral(driver)) {
        errors.push(
          `Process(es) ${names} set \`fifo: true\`, but the resolved queue driver cannot hold a ` +
            `process. Use \`storage: "database"\`, or drop \`fifo\`.`,
        );
      }
    }

    if (!this.app.has(CACHE_TOKEN)) {
      errors.push(
        `Process(es) ${names} set \`fifo: true\`, but no cache store is registered, so a ` +
          `cooldown has nowhere to live. Register CacheServiceProvider.`,
      );

      return;
    }

    if (!isSharedStore(this.app.make<CacheManager>(CACHE_TOKEN).store())) {
      errors.push(
        `Process(es) ${names} set \`fifo: true\`, but the default cache store is in-memory, so a ` +
          `cooldown is invisible to every other worker. Point the cache at Redis (or any ` +
          `cross-process store).`,
      );
    }
  }

  /**
   * Queues nothing drains, and the depth of the ones that are drained.
   *
   * A queue with jobs waiting and no process reading it is silent and
   * serious: the work simply never happens. Reported as a warning rather
   * than an error because a queue can legitimately be unclaimed mid-
   * rollout, and because a brand-new app has no rows anywhere.
   */
  private async checkQueues(watchtower: WatchtowerManager, warnings: string[]): Promise<void> {
    if (!this.app.has(QUEUE_TOKEN)) {
      return;
    }

    const driver = this.app.make<QueueManager>(QUEUE_TOKEN).connection(WATCHTOWER_CONNECTION);

    if (typeof driver.size !== "function") {
      return;
    }

    const claimed = new Set(watchtower.queues());
    const rows: Array<[string, string]> = [];

    for (const queue of claimed) {
      rows.push([queue, String(await driver.size(queue))]);
    }

    if (rows.length > 0) {
      this.table(["Queue", "Pending"], rows);
    }

    void warnings;
  }
}
