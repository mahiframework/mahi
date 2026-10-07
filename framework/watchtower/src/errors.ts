/**
 * The error family this package throws.
 *
 * One base class so an app can `catch (e) { if (e instanceof WatchtowerError) }`
 * without enumerating the subclasses.
 */
export class WatchtowerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The config describes work that cannot happen as written.
 *
 * Thrown at boot, carrying EVERY problem rather than the first, because
 * a config with two mistakes should not take two deploys to fix.
 *
 * Every condition this reports is one where the alternative is silence:
 * a process whose jobs are never worked, a cooldown that does nothing, a
 * `fifo` promise the driver cannot keep. A queue that quietly does not
 * run is the worst failure mode available to a queue package, so these
 * are errors rather than warnings.
 */
export class WatchtowerConfigError extends WatchtowerError {
  constructor(readonly problems: readonly string[]) {
    super(
      problems.length === 1
        ? `Invalid watchtower config: ${problems[0]}`
        : `Invalid watchtower config:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
}

/**
 * A process asked for `fifo` on a driver with no `defer()`.
 *
 * Separate from `WatchtowerConfigError` because it is only detectable
 * once the driver is resolved, which happens after config validation.
 * Still a hard error: falling back to `release()` would increment
 * `attempts` on every cooldown and fail jobs that never failed, which is
 * worse than refusing to start.
 */
export class DeferralUnsupportedError extends WatchtowerError {
  constructor(
    readonly process: string,
    readonly storage: string,
  ) {
    super(
      `Process "${process}" sets \`fifo: true\`, but the "${storage}" storage driver cannot defer a queue. ` +
        `Use \`storage: "database"\`, or drop \`fifo\` from this process.`,
    );
  }
}

/**
 * `Watchtower.gate()` was called more than once.
 *
 * There is one answer to "who may view the dashboard". An appending
 * registry would make that answer depend on provider order, and a
 * silently-replacing one would make a stray second call a security
 * change nobody reviewed. Register it once.
 */
export class GateAlreadyRegisteredError extends WatchtowerError {
  constructor() {
    super(
      "A watchtower gate is already registered. There is one answer to who may view the dashboard, " +
        "so register `Watchtower.gate(...)` exactly once, in one provider's boot().",
    );
  }
}

/** A process name that no configured process matches. */
export class UnknownProcessError extends WatchtowerError {
  constructor(
    readonly process: string,
    readonly known: readonly string[],
  ) {
    super(
      `There is no watchtower process named "${process}". Configured processes: ` +
        (known.length > 0 ? known.join(", ") : "(none)") +
        ".",
    );
  }
}
