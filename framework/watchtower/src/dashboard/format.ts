/**
 * Turning raw numbers into display strings.
 *
 * Separate from both the theme and the read model on purpose. The read
 * model carries raw values (`oldestPendingSeconds`, `failureRate: 0..1`)
 * so a caller rendering into its own UI is not parsing strings back; the
 * theme maps data to markup. Formatting is the third thing, shared by the
 * HTML theme and the TUI commands so the two never disagree about what
 * "18m" means.
 *
 * Nothing here escapes anything. These produce digits, units and
 * punctuation from numeric input, so they cannot introduce markup —
 * but every interpolation of their OUTPUT still goes through
 * `escapeHtml()` at the call site, without exception, because a
 * formatter that later grows a passthrough branch must not silently
 * become an injection path.
 */

/** A duration in seconds as `3h 12m`, `18m 04s`, `31s`. */
export function formatAge(seconds: number | null): string {
  if (seconds === null) {
    return "—";
  }

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m ${pad(seconds % 60)}s`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours}h ${pad(minutes % 60)}m`;
  }

  return `${Math.floor(hours / 24)}d ${pad(hours % 24)}h`;
}

/** A duration in milliseconds as `842ms`, `4.2s`, `1m 12s`. */
export function formatDuration(ms: number | null): string {
  if (ms === null) {
    return "—";
  }

  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  const seconds = ms / 1000;

  if (seconds < 60) {
    // One decimal place up to a minute: the difference between 4.2s and
    // 4.8s matters when tuning a timeout, and both round to "4s".
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);

  return `${minutes}m ${pad(Math.floor(seconds % 60))}s`;
}

/** A count with thousands separators. */
export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * A 0..1 rate as a percentage.
 *
 * Two decimal places below 1%, because the difference between 0.05% and
 * 0.5% is an order of magnitude and both would render as "1%" otherwise.
 */
export function formatRate(rate: number): string {
  if (rate === 0) {
    return "0%";
  }

  const percent = rate * 100;

  return percent < 1 ? `${percent.toFixed(2)}%` : `${percent.toFixed(1)}%`;
}

/** A throughput as `28.4/min`. */
export function formatThroughput(perMinute: number): string {
  return `${perMinute.toFixed(1)}/min`;
}

/**
 * An ISO timestamp as a relative age (`2m ago`, `3h ago`).
 *
 * Relative rather than absolute because the question an operator is
 * asking is "how stale is this", and answering it with a wall-clock time
 * makes them do the subtraction. `now` is injectable so a test is not
 * racing the clock.
 */
export function formatRelative(iso: string | null, now = Date.now()): string {
  if (iso === null) {
    return "—";
  }

  const at = Date.parse(iso);

  if (!Number.isFinite(at)) {
    return "—";
  }

  const seconds = Math.max(0, Math.round((now - at) / 1000));

  return seconds < 5 ? "just now" : `${formatAge(seconds)} ago`;
}

/**
 * A stack trace trimmed to its first few lines.
 *
 * The full text stays available behind a `<details>`; this is what shows
 * collapsed. First lines rather than a character budget, because a trace's
 * value is front-loaded: the message and the innermost frame answer most
 * questions.
 */
export function summariseTrace(trace: string | null, lines = 3): string {
  if (trace === null) {
    return "";
  }

  const split = trace.split("\n");

  return split.length <= lines ? trace : split.slice(0, lines).join("\n");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
