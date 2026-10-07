import type { Severity } from "../stats.js";

/**
 * The intermediate representation a theme renders.
 *
 * This is the one piece of the dashboard that has an opinion about what a
 * page CONTAINS rather than how it looks. The opinion is deliberately
 * small: seven section shapes, reused throughout.
 *
 * Sections are a discriminated union of PLAIN DATA — no strings of HTML,
 * no functions, no class instances. That is what makes a theme
 * swappable: a theme receives a description of the page, never a
 * half-rendered fragment it would have to parse or patch. It also means
 * the page can be asserted structurally in a test rather than by
 * string-matching generated markup, which is the difference between a
 * test that catches a missing column and one that catches a reformatted
 * attribute.
 *
 * **All text here is UNESCAPED.** Escaping is the theme's job, because
 * only the theme knows which output it is producing — and a pre-escaped
 * IR could not be rendered to anything else. A theme that forgets to
 * escape produces an injection bug, so `DefaultDashboardTheme` routes
 * every interpolation through `escapeHtml()` and any custom theme must
 * do the same.
 */

/** A page: a title, a nav state, and an ordered list of sections. */
export interface DashboardPage {
  /** Document title and heading. */
  title: string;
  /** A short line under the heading. */
  subtitle?: string;
  /** Small caps label above the heading. */
  eyebrow?: string;
  /** Which nav entry is current. */
  active: "overview" | "failed" | "job";
  /** Link back to the overview, for a detail view. */
  backTo?: DashboardLink;
  nav: DashboardNav;
  sections: DashboardSection[];
  /** Rendered small and right-aligned at the foot of the page. */
  footer?: string;
  /** Seconds between background refreshes. Zero disables polling. */
  pollSeconds: number;
  /** Where the poll fetches from. */
  dataUrl: string;
}

export interface DashboardNav {
  overviewUrl: string;
  failedUrl: string;
  /** Shown as a badge on the failed-jobs link. */
  failedCount: number;
}

export interface DashboardLink {
  label: string;
  url: string;
}

export type DashboardSection =
  | AlertSection
  | MetricStripSection
  | TableSection
  | ColumnsSection
  | FailureListSection
  | ChainListSection
  | EmptySection;

/**
 * A banner. The only section that exists to interrupt.
 *
 * `severity` drives colour; a `danger` alert is the most severe thing on
 * the page and should be unmissable, because the condition it reports
 * (a crash-looping process) means work has silently stopped.
 */
export interface AlertSection {
  kind: "alert";
  severity: Severity;
  title: string;
  detail: string;
  action?: DashboardLink;
}

/** The row of big numbers at the top of a page. */
export interface MetricStripSection {
  kind: "metrics";
  metrics: DashboardMetric[];
}

export interface DashboardMetric {
  label: string;
  value: string;
  meta?: string;
  severity?: Severity;
}

/**
 * A table with a heading.
 *
 * Cells carry their own severity so the theme only maps it to a class —
 * the thresholds that decide "this queue is late" live in `stats.ts`, so
 * every surface agrees and changing one is one edit.
 */
export interface TableSection {
  kind: "table";
  heading: string;
  eyebrow?: string;
  /** Right-aligned note in the section header. */
  note?: string;
  columns: string[];
  rows: DashboardRow[];
  /** Shown in place of the table when `rows` is empty. */
  emptyText?: string;
}

export interface DashboardRow {
  cells: DashboardCell[];
  /** Makes the whole row a link. */
  url?: string;
}

export interface DashboardCell {
  text: string;
  /** Secondary line under the main text. */
  sub?: string;
  severity?: Severity;
  /** Rendered as a small bordered tag after the text. */
  tag?: string;
  /** Rendered monospace with a copy button — for an id worth pasting. */
  copyable?: boolean;
  /** Percentage heights, 0..100, rendered as a bar sparkline. */
  spark?: number[];
}

/** Two sections side by side, collapsing to one column when narrow. */
export interface ColumnsSection {
  kind: "columns";
  left: DashboardSection;
  right: DashboardSection;
}

/** Failed attempts, each with its collapsible stack trace. */
export interface FailureListSection {
  kind: "failures";
  heading: string;
  eyebrow?: string;
  note?: string;
  failures: DashboardFailure[];
  emptyText?: string;
}

export interface DashboardFailure {
  jobLabel: string;
  jobUrl?: string;
  attempt: number;
  /** Relative, e.g. `"2m 04s ago"`. */
  when: string;
  process: string | null;
  queue: string | null;
  dispatchId: string;
  invocationId: string | null;
  /** UNTRUSTED. A stack trace, shown collapsed. */
  trace: string | null;
  /** POSTs here to retry. Absent when the driver cannot retry. */
  retryUrl?: string;
}

/** Attempts grouped by dispatch, so a retry chain reads as one event. */
export interface ChainListSection {
  kind: "chains";
  heading: string;
  eyebrow?: string;
  note?: string;
  chains: DashboardChain[];
  emptyText?: string;
}

export interface DashboardChain {
  dispatchId: string;
  attempts: DashboardChainAttempt[];
}

export interface DashboardChainAttempt {
  status: string;
  severity: Severity;
  attempt: number;
  when: string;
  duration: string;
  invocationId: string | null;
}

/** A standalone "nothing here" panel. */
export interface EmptySection {
  kind: "empty";
  title: string;
  detail?: string;
}
