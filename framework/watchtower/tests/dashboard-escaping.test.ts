import { describe, expect, it } from "vitest";
import { DefaultDashboardTheme } from "../src/dashboard/default-dashboard-theme.js";
import type { DashboardPage, DashboardSection } from "../src/dashboard/dashboard-page.js";

const theme = new DefaultDashboardTheme();

const XSS = "<script>alert(1)</script>";

function page(sections: DashboardSection[], overrides: Partial<DashboardPage> = {}): string {
  return theme.render({
    title: "Queue health",
    active: "overview",
    nav: { overviewUrl: "/watchtower", failedUrl: "/watchtower/failed", failedCount: 0 },
    sections,
    pollSeconds: 5,
    dataUrl: "/watchtower/data",
    ...overrides,
  });
}

/**
 * The one test that makes the theme safe to extend.
 *
 * A queue dashboard's most valuable column is attacker-adjacent by
 * construction: a failure's `error` is `error.stack ?? error.message`,
 * and a job can trivially throw an error whose message embeds user
 * input. Every field below is reachable from something an attacker can
 * influence.
 */
describe("dashboard escaping", () => {
  it("escapes a stack trace, the primary vector", () => {
    const html = page([
      {
        kind: "failures",
        heading: "Recent failures",
        failures: [
          {
            jobLabel: "app.jobs.sync",
            attempt: 1,
            when: "2m ago",
            process: "default",
            queue: "default",
            dispatchId: "d1",
            invocationId: null,
            trace: `Error: Invalid email: ${XSS}\n    at Foo.bar (src/foo.ts:1:1)`,
          },
        ],
      },
    ]);

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("keeps a trace readable inside a pre while escaping it", () => {
    const html = page([
      {
        kind: "failures",
        heading: "Recent failures",
        failures: [
          {
            jobLabel: "j",
            attempt: 1,
            when: "now",
            process: null,
            queue: null,
            dispatchId: "d",
            invocationId: null,
            trace: "Error: boom\n    at Foo.bar (src/foo.ts:1:1)",
          },
        ],
      },
    ]);

    // `<pre>` governs whitespace, escaping governs safety, and the two
    // are orthogonal: the indentation that makes a trace readable
    // survives, and no tag does.
    expect(html).toContain("<pre>Error: boom\n    at Foo.bar (src/foo.ts:1:1)</pre>");
  });

  it("escapes every field of a failure row", () => {
    const html = page([
      {
        kind: "failures",
        heading: XSS,
        eyebrow: XSS,
        note: XSS,
        failures: [
          {
            jobLabel: XSS,
            jobUrl: `/x?q=${XSS}`,
            attempt: 1,
            when: XSS,
            process: XSS,
            queue: XSS,
            dispatchId: XSS,
            invocationId: XSS,
            trace: XSS,
            retryUrl: `/retry?q=${XSS}`,
          },
        ],
      },
    ]);

    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("escapes table cells, subs, tags and empty text", () => {
    const html = page([
      {
        kind: "table",
        heading: XSS,
        eyebrow: XSS,
        note: XSS,
        columns: [XSS],
        rows: [
          {
            url: `/row?q=${XSS}`,
            cells: [{ text: XSS, sub: XSS, tag: XSS, copyable: true, severity: "danger" }],
          },
        ],
        emptyText: XSS,
      },
    ]);

    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("escapes a copy button's value, which lands in an attribute", () => {
    const html = page([
      {
        kind: "table",
        heading: "ids",
        columns: ["id"],
        rows: [{ cells: [{ text: '" onclick="alert(1)', copyable: true }] }],
      },
    ]);

    // An attribute-context break is the subtler half of the same
    // problem: `escapeHtml` covers `"` and `'` for exactly this.
    expect(html).not.toContain('onclick="alert(1)"');
    expect(html).toContain("&quot;");
  });

  it("escapes metrics, alerts, chains and empty sections", () => {
    const html = page([
      {
        kind: "alert",
        severity: "danger",
        title: XSS,
        detail: XSS,
        action: { label: XSS, url: XSS },
      },
      { kind: "metrics", metrics: [{ label: XSS, value: XSS, meta: XSS }] },
      {
        kind: "chains",
        heading: XSS,
        chains: [
          {
            dispatchId: XSS,
            attempts: [
              {
                status: XSS,
                severity: "danger",
                attempt: 1,
                when: XSS,
                duration: XSS,
                invocationId: XSS,
              },
            ],
          },
        ],
      },
      { kind: "empty", title: XSS, detail: XSS },
    ]);

    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("escapes the page chrome", () => {
    const html = page([], {
      title: XSS,
      subtitle: XSS,
      eyebrow: XSS,
      footer: XSS,
      backTo: { label: XSS, url: XSS },
      nav: { overviewUrl: XSS, failedUrl: XSS, failedCount: 3 },
    });

    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("clamps a sparkline rather than emitting a bar outside its box", () => {
    const html = page([
      {
        kind: "table",
        heading: "t",
        columns: ["c"],
        rows: [{ cells: [{ text: "x", spark: [-50, 50, 9999] }] }],
      },
    ]);

    expect(html).toContain("height:0%");
    expect(html).toContain("height:50%");
    expect(html).toContain("height:100%");
    expect(html).not.toContain("height:9999%");
  });
});

/**
 * The no-CDN rule, asserted rather than trusted — it is exactly the kind
 * of thing a later convenience edit breaks silently.
 */
describe("dashboard self-containment", () => {
  it("loads nothing over the network", () => {
    const html = page([{ kind: "metrics", metrics: [{ label: "Pending", value: "12" }] }]);

    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toContain("<link");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("@import");
    expect(html).not.toMatch(/url\(/);
  });

  it("inlines exactly one stylesheet and emits the document shell", () => {
    const html = page([]);

    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('<meta name="viewport"');
    // An internal tool occasionally lands on a reachable host, and a
    // queue dashboard in a search index is a disclosure.
    expect(html).toContain('name="robots"');
  });

  it("emits no poll loop when polling is disabled", () => {
    const html = page([], { pollSeconds: 0 });

    expect(html).not.toContain("setTimeout");
    // The copy and retry handlers are not polling and must survive.
    expect(html).toContain("data-watchtower-copy");
  });

  it("injects the poll url as JSON, not as HTML", () => {
    const html = page([], { dataUrl: '/watchtower/data?x="y' });

    // Inside a `<script>` element HTML escaping is the wrong encoding
    // and would be rendered literally, breaking the script.
    expect(html).toContain('"/watchtower/data?x=\\"y"');
  });
});
