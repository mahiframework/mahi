import type { ResolvedWatchtowerConfig } from "./watchtower-config.js";

/**
 * A problem with a resolved config, and whether it must stop the boot.
 *
 * `"error"` means the config describes work that cannot happen as
 * written — a queue nobody drains, a cooldown that silently does
 * nothing. `"warning"` means it is legal but probably a mistake, or
 * legitimately transient during a rollout.
 *
 * Reported as data rather than thrown immediately so `watchtower:check`
 * can print every problem at once, and so the provider can throw a
 * single error carrying all of them. A config with two mistakes should
 * not take two deploys to fix.
 */
export interface ConfigProblem {
  level: "error" | "warning";
  message: string;
}

/**
 * Everything checkable without resolving the queue driver or the cache
 * store.
 *
 * The two conditions that need those — `fifo` against a driver with no
 * `defer()`, and `fifo` against a per-process cache store — are checked
 * where they are knowable (`DeferralUnsupportedError` at worker start,
 * and `requireSharedStore()`), because a config file is validated before
 * the container is built.
 */
export function validateConfig(config: ResolvedWatchtowerConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const claimedBy = new Map<string, string[]>();
  const names = new Set<string>();

  for (const process of config.processes) {
    if (process.name.trim() === "") {
      problems.push({ level: "error", message: "A process has an empty name." });
    } else if (names.has(process.name)) {
      problems.push({
        level: "error",
        message:
          `Two processes are named "${process.name}". Names identify a process in logs, in ` +
          `\`watchtower:pause\` and in its cache keys, so they must be unique.`,
      });
    }

    names.add(process.name);

    if (process.queues.length === 0) {
      problems.push({
        level: "error",
        message: `Process "${process.name}" drains no queues, so its workers would poll nothing forever.`,
      });
    }

    // Reported rather than silently clamped: a multi-worker `fifo`
    // process looks configured for ordering and is not, and that only
    // shows up under load. `resolveProcess()` deliberately preserves
    // `workers` so this is observable at all.
    if (process.fifo && process.workers > 1) {
      problems.push({
        level: "error",
        message:
          `Process "${process.name}" sets \`fifo: true\` and \`workers: ${process.workers}\`. ` +
          `A cooldown is process-wide, but a second worker can already hold the next job when the ` +
          `first defers, so ordering is not guaranteed. Use one worker, or split the queues across ` +
          `more processes.`,
      });
    }

    if (process.maxDeferrals <= 0) {
      problems.push({
        level: "error",
        message:
          `Process "${process.name}" sets \`maxDeferrals: ${process.maxDeferrals}\`, which would ` +
          `refuse every cooldown. Omit it for the default, or give it a positive number.`,
      });
    }

    for (const queue of process.queues) {
      const claimants = claimedBy.get(queue) ?? [];
      claimants.push(process.name);
      claimedBy.set(queue, claimants);
    }
  }

  for (const [queue, claimants] of claimedBy) {
    if (claimants.length > 1) {
      problems.push({
        level: "warning",
        message:
          `Queue "${queue}" is drained by more than one process (${claimants.join(", ")}). ` +
          `That is legal and occasionally deliberate, but it means neither process's cooldown ` +
          `covers the other.`,
      });
    }
  }

  if (config.recording.enabled && config.recording.queued) {
    const metricsQueue = config.recording.queue;

    if (!claimedBy.has(metricsQueue)) {
      problems.push({
        level: "warning",
        message:
          `Run history is queued onto "${metricsQueue}", but no process drains it, so nothing is ` +
          `recorded. Add a process for it, or set \`recording.queued: false\` to write inline.`,
      });
    }
  }

  if (config.recording.retentionDays <= 0) {
    problems.push({
      level: "error",
      message:
        `\`recording.retentionDays\` is ${config.recording.retentionDays}. \`watchtower:prune\` ` +
        `would delete every row it can see.`,
    });
  }

  return problems;
}

/** Just the blocking problems, for a caller that only cares whether to throw. */
export function configErrors(config: ResolvedWatchtowerConfig): string[] {
  return validateConfig(config)
    .filter((problem) => problem.level === "error")
    .map((problem) => problem.message);
}
