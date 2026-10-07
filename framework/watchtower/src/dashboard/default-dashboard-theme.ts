import { Str } from "@mahiframework/core";
import type { Severity } from "../stats.js";
import type {
  AlertSection,
  ChainListSection,
  ColumnsSection,
  DashboardCell,
  DashboardFailure,
  DashboardLink,
  DashboardPage,
  DashboardSection,
  EmptySection,
  FailureListSection,
  MetricStripSection,
  TableSection,
} from "./dashboard-page.js";
import type { DashboardTheme } from "./dashboard-theme.js";
import { DASHBOARD_STYLES } from "./styles.js";

/**
 * The bundled theme: a dense, monospace, light-and-dark operator view.
 *
 * Written as template literals rather than as a template file on disk
 * for two reasons. It keeps the package free of any template engine or
 * asset pipeline — a `.html` file would need a loader, and a bundled app
 * has no filesystem to read it from, the same constraint that forces
 * static migration imports. And it makes the theme SUBCLASSABLE: every
 * piece of markup is a small protected method, so an app that wants a
 * different table but the same layout overrides `table()` and inherits
 * everything else, which no template file would allow without copying
 * the whole thing.
 *
 * ## Every interpolation is escaped
 *
 * Without exception. `escape()` wraps `Str.escapeHtml`, and the rule is
 * absolute rather than case-by-case because the alternative is auditing
 * each site forever. Two fields make this load-bearing rather than
 * hygienic: a failure's `trace` and anything derived from a job's error
 * are `error.stack ?? error.message`, and a job can trivially throw an
 * error whose message embeds user input.
 *
 * `<pre>` is used for traces and that is NOT a gap in the escaping.
 * `<pre>` governs whitespace; escaping governs safety, and the two are
 * orthogonal. `<pre>${escape(trace)}</pre>` renders `&lt;script&gt;` as
 * literal text while preserving the leading indentation on
 * `    at Foo.bar (…)` that makes a trace readable. A mono-font `<div>`
 * would collapse that indentation and buy no safety at all.
 *
 * ## One self-contained document
 *
 * One `<style>`, one `<script>`, nothing fetched. See `DashboardTheme`.
 */
export class DefaultDashboardTheme implements DashboardTheme {
  render(page: DashboardPage): string {
    return this.layout(page);
  }

  renderSections(page: DashboardPage): string {
    return this.sections(page.sections);
  }

  // ------------------------------------------------------------- document

  protected layout(page: DashboardPage): string {
    return [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      // `noindex` because this is an internal tool that occasionally ends
      // up on a reachable host, and a queue dashboard in a search index
      // is a disclosure.
      '<meta name="robots" content="noindex,nofollow">',
      `<title>${this.escape(page.title)} · Watchtower</title>`,
      `<style>${this.styles()}</style>`,
      "</head>",
      "<body>",
      this.topbar(page),
      '<main class="shell">',
      page.backTo === undefined ? "" : this.backLink(page.backTo),
      this.pageTitle(page),
      `<div id="watchtower-body">${this.sections(page.sections)}</div>`,
      page.footer === undefined ? "" : this.footer(page.footer),
      "</main>",
      this.script(page),
      "</body>",
      "</html>",
    ].join("");
  }

  /** The stylesheet. Override to rebrand beyond the custom properties. */
  protected styles(): string {
    return DASHBOARD_STYLES;
  }

  protected topbar(page: DashboardPage): string {
    const badge =
      page.nav.failedCount > 0 ? `<b>${this.escape(String(page.nav.failedCount))}</b>` : "";

    return [
      '<header class="topbar">',
      '<div class="brand"><span class="brand-mark"><span></span></span><span>watchtower</span>',
      "<small>queue monitor</small></div>",
      "<nav>",
      `<a class="${page.active === "overview" ? "active" : ""}" href="${this.escape(page.nav.overviewUrl)}">Overview</a>`,
      `<a class="${page.active === "failed" ? "active" : ""}" href="${this.escape(page.nav.failedUrl)}">Failed jobs ${badge}</a>`,
      "</nav>",
      '<div class="live">',
      this.dot("ok"),
      ' Live <span class="divider"></span> ',
      '<span class="muted" id="watchtower-updated"></span>',
      "</div>",
      "</header>",
    ].join("");
  }

  protected pageTitle(page: DashboardPage): string {
    return [
      '<div class="page-title"><div>',
      page.eyebrow === undefined ? "" : `<div class="eyebrow">${this.escape(page.eyebrow)}</div>`,
      `<h1>${this.escape(page.title)}</h1>`,
      page.subtitle === undefined ? "" : `<p>${this.escape(page.subtitle)}</p>`,
      "</div></div>",
    ].join("");
  }

  protected backLink(link: DashboardLink): string {
    return `<a class="back" href="${this.escape(link.url)}">← ${this.escape(link.label)}</a>`;
  }

  protected footer(text: string): string {
    return `<div class="footer-note">${this.escape(text)}</div>`;
  }

  // ------------------------------------------------------------- sections

  protected sections(sections: DashboardSection[]): string {
    return sections.map((section) => this.section(section)).join("");
  }

  protected section(section: DashboardSection): string {
    switch (section.kind) {
      case "alert":
        return this.alert(section);
      case "metrics":
        return this.metrics(section);
      case "table":
        return this.table(section);
      case "columns":
        return this.columns(section);
      case "failures":
        return this.failures(section);
      case "chains":
        return this.chains(section);
      case "empty":
        return this.empty(section);
    }
  }

  protected alert(section: AlertSection): string {
    const tone = section.severity === "danger" ? "severe" : "warning";

    return [
      `<div class="alert ${tone}"><span class="alert-icon">!</span><div>`,
      `<strong>${this.escape(section.title)}</strong>`,
      `<span>${this.escape(section.detail)}</span>`,
      "</div>",
      section.action === undefined
        ? ""
        : `<a href="${this.escape(section.action.url)}">${this.escape(section.action.label)} →</a>`,
      "</div>",
    ].join("");
  }

  protected metrics(section: MetricStripSection): string {
    const cells = section.metrics
      .map((metric) =>
        [
          `<div class="metric ${metric.severity === "danger" ? "metric-danger" : ""}">`,
          `<span>${this.escape(metric.label)}</span>`,
          `<strong>${this.escape(metric.value)}</strong>`,
          metric.meta === undefined ? "" : `<small>${this.escape(metric.meta)}</small>`,
          "</div>",
        ].join(""),
      )
      .join("");

    return `<div class="metrics">${cells}</div>`;
  }

  protected table(section: TableSection): string {
    const header = section.columns.map((column) => `<span>${this.escape(column)}</span>`).join("");

    const body =
      section.rows.length === 0
        ? `<div class="empty muted-box"><span>${this.escape(section.emptyText ?? "Nothing here.")}</span></div>`
        : section.rows.map((row) => this.row(row, section.columns.length)).join("");

    return [
      this.sectionOpen(section.heading, section.eyebrow, section.note),
      `<div class="table"><div class="tr th">${header}</div>`,
      body,
      "</div></section>",
    ].join("");
  }

  protected row(row: { cells: DashboardCell[]; url?: string }, columns: number): string {
    const cells = row.cells.map((cell) => this.cell(cell)).join("");
    const style = `style="grid-template-columns:repeat(${columns},1fr)"`;

    return row.url === undefined
      ? `<div class="tr" ${style}>${cells}</div>`
      : `<a class="tr row-link" ${style} href="${this.escape(row.url)}">${cells}</a>`;
  }

  protected cell(cell: DashboardCell): string {
    const classes = ["mono"];

    if (cell.severity === "danger") {
      classes.push("danger");
    } else if (cell.severity === "warn") {
      classes.push("amber");
    }

    return [
      `<span class="${classes.join(" ")}">`,
      cell.spark === undefined ? "" : this.spark(cell.spark),
      this.escape(cell.text),
      cell.copyable === true ? this.copyButton(cell.text) : "",
      cell.tag === undefined ? "" : `<em class="tag">${this.escape(cell.tag)}</em>`,
      cell.sub === undefined ? "" : `<small class="subline">${this.escape(cell.sub)}</small>`,
      "</span>",
    ].join("");
  }

  /**
   * A bar sparkline built from divs with percentage heights.
   *
   * No charting library and no SVG path maths: the values are
   * server-computed percentages, so the markup is N empty elements and
   * the CSS does the rest. Clamped to 0..100 because a value outside
   * that range would render a bar outside its container.
   */
  protected spark(values: number[]): string {
    const bars = values
      .map((value) => {
        const height = Math.max(0, Math.min(100, Math.round(value)));

        return `<i style="height:${height}%"></i>`;
      })
      .join("");

    return `<span class="spark">${bars}</span>`;
  }

  protected columns(section: ColumnsSection): string {
    return [
      '<div class="grid-2">',
      this.section(section.left),
      this.section(section.right),
      "</div>",
    ].join("");
  }

  protected failures(section: FailureListSection): string {
    const body =
      section.failures.length === 0
        ? `<div class="empty muted-box"><span>${this.escape(section.emptyText ?? "No failures.")}</span></div>`
        : section.failures.map((failure) => this.failure(failure)).join("");

    return [
      this.sectionOpen(section.heading, section.eyebrow, section.note),
      `<div class="failure-list">${body}</div>`,
      "</section>",
    ].join("");
  }

  protected failure(failure: DashboardFailure): string {
    const label =
      failure.jobUrl === undefined
        ? this.escape(failure.jobLabel)
        : `<a href="${this.escape(failure.jobUrl)}">${this.escape(failure.jobLabel)}</a>`;

    return [
      '<article class="failure-row"><div class="failure-main">',
      '<div class="failure-title">',
      `<span class="state failed">${this.dot("danger")}failed</span>`,
      label,
      `<span class="muted">· attempt ${this.escape(String(failure.attempt))}</span>`,
      `<span class="muted">· ${this.escape(failure.when)}</span>`,
      "</div>",
      '<div class="failure-meta">',
      `<span>process <b>${this.escape(failure.process ?? "—")}</b></span>`,
      `<span>queue <b>${this.escape(failure.queue ?? "—")}</b></span>`,
      `<span>dispatchId <code>${this.escape(failure.dispatchId)}</code></span>`,
      failure.invocationId === null
        ? ""
        : `<span>invocationId <code>${this.escape(failure.invocationId)}</code>${this.copyButton(failure.invocationId)}</span>`,
      "</div>",
      this.trace(failure.trace),
      "</div>",
      '<div class="failure-actions">',
      failure.retryUrl === undefined ? "" : this.retryForm(failure.retryUrl),
      "</div></article>",
    ].join("");
  }

  /**
   * A stack trace, collapsed behind a `<details>`.
   *
   * `<details>` rather than a toggle button because it needs no
   * JavaScript and no client state — which matters on a page that is
   * wholly replaced every few seconds, where any JS-held open/closed flag
   * would be lost on the next refresh anyway.
   */
  protected trace(trace: string | null): string {
    if (trace === null || trace === "") {
      return "";
    }

    return [
      "<details><summary>Show stack trace</summary>",
      // Escaped, and inside a `<pre>`: the escaping makes it safe, the
      // `<pre>` keeps the indentation that makes it readable.
      `<pre>${this.escape(trace)}</pre>`,
      "</details>",
    ].join("");
  }

  /**
   * The retry button, as a real form.
   *
   * A POST rather than a link, because retrying is not idempotent and a
   * crawler or a prefetch must not trigger it. The CSRF header is
   * attached by the inline script, since the app's `csrf()` middleware is
   * header-based double-submit and a plain form cannot satisfy it.
   */
  protected retryForm(url: string): string {
    return [
      `<form method="post" action="${this.escape(url)}" data-watchtower-retry>`,
      '<button class="button" type="submit">Retry job</button>',
      "</form>",
    ].join("");
  }

  protected chains(section: ChainListSection): string {
    const body =
      section.chains.length === 0
        ? `<div class="empty muted-box"><span>${this.escape(section.emptyText ?? "No attempts yet.")}</span></div>`
        : section.chains
            .map((chain) =>
              [
                '<div class="chain"><div class="chain-head">',
                '<span class="chain-icon">↳</span>',
                `<strong>dispatchId <code>${this.escape(chain.dispatchId)}</code></strong>`,
                `<span class="muted">${this.escape(String(chain.attempts.length))} attempts</span>`,
                "</div>",
                chain.attempts
                  .map((attempt) =>
                    [
                      '<div class="attempt">',
                      `<span class="state ${attempt.severity === "ok" ? "running" : "failed"}">`,
                      this.dot(attempt.severity),
                      this.escape(attempt.status),
                      "</span>",
                      `<span>attempt <b>${this.escape(String(attempt.attempt))}</b></span>`,
                      `<span class="muted">${this.escape(attempt.when)}</span>`,
                      `<span class="muted">${this.escape(attempt.duration)}</span>`,
                      attempt.invocationId === null
                        ? ""
                        : `<span>invocationId <code>${this.escape(attempt.invocationId)}</code>${this.copyButton(attempt.invocationId)}</span>`,
                      "</div>",
                    ].join(""),
                  )
                  .join(""),
                "</div>",
              ].join(""),
            )
            .join("");

    return [
      this.sectionOpen(section.heading, section.eyebrow, section.note),
      `<div class="chain-list">${body}</div>`,
      "</section>",
    ].join("");
  }

  protected empty(section: EmptySection): string {
    return [
      '<div class="empty muted-box"><div class="empty-mark">✓</div>',
      `<strong>${this.escape(section.title)}</strong>`,
      section.detail === undefined ? "" : `<span>${this.escape(section.detail)}</span>`,
      "</div>",
    ].join("");
  }

  // -------------------------------------------------------------- pieces

  protected sectionOpen(heading: string, eyebrow?: string, note?: string): string {
    return [
      '<section class="section"><div class="section-head"><div>',
      eyebrow === undefined ? "" : `<div class="eyebrow">${this.escape(eyebrow)}</div>`,
      `<h2>${this.escape(heading)}</h2></div>`,
      note === undefined ? "" : `<span class="muted mono">${this.escape(note)}</span>`,
      "</div>",
    ].join("");
  }

  protected dot(severity: Severity): string {
    const tone = severity === "danger" ? "red" : severity === "warn" ? "amber" : "green";

    return `<i class="status-dot ${tone}"></i>`;
  }

  protected copyButton(value: string): string {
    return [
      '<button class="copy" type="button" aria-label="Copy"',
      ` data-watchtower-copy="${this.escape(value)}">⧉</button>`,
    ].join("");
  }

  /**
   * The poll-and-replace script.
   *
   * About twenty lines, written by hand rather than ported from
   * anything. It replaces the innerHTML of one container from a JSON
   * endpoint that returns pre-rendered section markup, which is why the
   * page holds no client state: there is nothing to preserve across a
   * refresh.
   *
   * Three things it does that matter. It backs off on failure rather than
   * hammering a server that is already unwell. It stops polling when the
   * tab is hidden, so a dashboard left open overnight costs nothing. And
   * it attaches the CSRF header to the retry form, which is the one thing
   * a plain `<form>` cannot do against header-based double-submit.
   */
  protected script(page: DashboardPage): string {
    if (page.pollSeconds <= 0) {
      return `<script>${this.copyScript()}${this.retryScript()}</script>`;
    }

    // `JSON.stringify` on both injected values: they land inside a
    // script element, where HTML escaping is the wrong encoding and
    // would be rendered literally.
    const url = JSON.stringify(page.dataUrl);
    const interval = JSON.stringify(page.pollSeconds * 1000);

    return [
      "<script>",
      this.copyScript(),
      this.retryScript(),
      "(function(){",
      `var url=${url},base=${interval},wait=base;`,
      'var body=document.getElementById("watchtower-body");',
      'var stamp=document.getElementById("watchtower-updated");',
      "var timer;",
      "function schedule(){clearTimeout(timer);timer=setTimeout(tick,wait);}",
      "function tick(){",
      "if(document.hidden){schedule();return;}",
      'fetch(url,{headers:{"Accept":"application/json"},credentials:"same-origin"})',
      ".then(function(r){if(!r.ok){throw new Error(r.status);}return r.json();})",
      ".then(function(d){",
      'if(d&&typeof d.html==="string"){body.innerHTML=d.html;}',
      'if(stamp&&d&&d.generatedAt){stamp.textContent="updated "+d.generatedAt;}',
      "wait=base;schedule();",
      "})",
      // Back off to at most a minute. A server that is struggling must
      // not be polled harder because its dashboard is open.
      ".catch(function(){wait=Math.min(wait*2,60000);schedule();});",
      "}",
      "schedule();",
      'document.addEventListener("visibilitychange",function(){if(!document.hidden){wait=base;tick();}});',
      "})();",
      "</script>",
    ].join("");
  }

  /** Copy-to-clipboard, delegated so it survives an innerHTML swap. */
  protected copyScript(): string {
    return [
      'document.addEventListener("click",function(e){',
      'var b=e.target.closest&&e.target.closest("[data-watchtower-copy]");',
      "if(!b){return;}",
      "e.preventDefault();",
      'var v=b.getAttribute("data-watchtower-copy");',
      "if(navigator.clipboard){navigator.clipboard.writeText(v);}",
      "});",
    ].join("");
  }

  /**
   * Attach the CSRF header to a retry submission.
   *
   * The app's `csrf()` pipe is signed double-submit: it reads a cookie
   * and expects the same value in a header. A plain form post cannot set
   * a header, so the submission is intercepted and re-sent as a fetch.
   * When no CSRF cookie is present the form posts normally, which is
   * correct for an app that has not enabled the pipe.
   */
  protected retryScript(): string {
    return [
      'document.addEventListener("submit",function(e){',
      "var f=e.target;",
      'if(!f.hasAttribute||!f.hasAttribute("data-watchtower-retry")){return;}',
      "e.preventDefault();",
      "var m=document.cookie.match(/(?:^|;\\s*)XSRF-TOKEN=([^;]*)/);",
      'var h={"Accept":"application/json"};',
      'if(m){h["X-XSRF-TOKEN"]=decodeURIComponent(m[1]);}',
      'fetch(f.action,{method:"POST",headers:h,credentials:"same-origin"})',
      ".then(function(){location.reload();});",
      "});",
    ].join("");
  }

  /**
   * HTML-escape every interpolation, without exception.
   *
   * A single chokepoint rather than a judgement at each site: the fields
   * that matter most here (a stack trace, a job class name) are exactly
   * the ones that look harmless until a job throws
   * `new Error("<script>…")`.
   */
  protected escape(value: string): string {
    return Str.escapeHtml(value);
  }
}
