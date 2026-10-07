import type { DashboardPage } from "./dashboard-page.js";

/**
 * Turns a `DashboardPage` into an HTML document.
 *
 * A theme is an OBJECT, not a template file, and that is the deliberate
 * departure from a Blade-style view system. This framework ships no
 * template engine and does not want one, so rather than inventing a
 * miniature one just for this package, the extension point is an
 * interface. A theme may be:
 *
 *   - Template literals in TypeScript, with no dependencies at all. That
 *     is what `DefaultDashboardTheme` is, and it is entirely readable.
 *   - A wrapper around whatever engine the app already uses.
 *   - A subclass of `DefaultDashboardTheme` overriding one method to
 *     change a colour or the table markup.
 *
 * All three plug in identically, and the page the controller builds is
 * unchanged by the choice — which is the whole point: swapping how the
 * dashboard looks must never mean rewriting what it reports.
 *
 * ## Escaping is the theme's responsibility
 *
 * `DashboardPage` carries raw, unescaped text. A theme MUST escape every
 * interpolation. This is delegated rather than done upfront because
 * escaping depends on the output format, and a pre-escaped IR could not
 * be rendered to anything but HTML.
 *
 * Two fields are attacker-adjacent by construction and must never be
 * interpolated raw: `DashboardFailure.trace` and anything derived from a
 * job's error, which is `error.stack ?? error.message` — and a job can
 * trivially throw an error whose message embeds user input.
 *
 * ## No external requests
 *
 * A theme must emit ONE self-contained document: no `<script src>`, no
 * `<link rel=stylesheet>`, no webfont, no CDN. Three reasons, any one
 * sufficient. An operator opens this on a bastion host with no egress,
 * where a CDN-dependent page renders unstyled exactly when it is needed
 * most. A remote origin running script in this page's origin has access
 * to every job payload on it. And an app-set
 * `Content-Security-Policy` has no reason to grant `script-src` for a
 * third party nobody asked for.
 */
export interface DashboardTheme {
  /** The whole document: head, chrome, sections, script. */
  render(page: DashboardPage): string;

  /**
   * Just the sections, for the background poll.
   *
   * The poll replaces one container rather than the document, so
   * re-sending `<head>` and the script would be waste at best and a
   * duplicated listener at worst. Separating the two is also what keeps
   * there being exactly ONE renderer: the alternative — ship data and
   * re-render client-side — needs a second implementation of every
   * section in JavaScript, and that second one is the one without the
   * escaping.
   */
  renderSections(page: DashboardPage): string;
}
