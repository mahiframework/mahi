import { describe, expect, it } from "vitest";
import {
  formatAge,
  formatCount,
  formatDuration,
  formatRate,
  formatRelative,
  formatThroughput,
  summariseTrace,
} from "../src/dashboard/format.js";

describe("formatAge", () => {
  it("renders an absent age as a dash, not zero", () => {
    // An empty queue has no oldest job. Rendering that as "0s" would
    // read as "a job is waiting and is brand new", which is the opposite.
    expect(formatAge(null)).toBe("—");
  });

  it("scales through seconds, minutes, hours and days", () => {
    expect(formatAge(0)).toBe("0s");
    expect(formatAge(31)).toBe("31s");
    expect(formatAge(1084)).toBe("18m 04s");
    expect(formatAge(11_520)).toBe("3h 12m");
    expect(formatAge(180_000)).toBe("2d 02h");
  });

  it("zero-pads the minor unit so columns line up", () => {
    expect(formatAge(64)).toBe("1m 04s");
    expect(formatAge(3900)).toBe("1h 05m");
  });
});

describe("formatDuration", () => {
  it("renders an absent duration as a dash", () => {
    expect(formatDuration(null)).toBe("—");
  });

  it("keeps a decimal place under a minute", () => {
    // The difference between 4.2s and 4.8s matters when tuning a
    // timeout, and both would round to "4s".
    expect(formatDuration(842)).toBe("842ms");
    expect(formatDuration(4200)).toBe("4.2s");
    expect(formatDuration(42_800)).toBe("42.8s");
  });

  it("switches to minutes past 60 seconds", () => {
    expect(formatDuration(72_000)).toBe("1m 12s");
  });
});

describe("formatRate", () => {
  it("keeps two decimals below one percent", () => {
    // 0.05% and 0.5% are an order of magnitude apart and would both
    // render as "1%" at one significant figure.
    expect(formatRate(0.0005)).toBe("0.05%");
    expect(formatRate(0.0015)).toBe("0.15%");
  });

  it("uses one decimal at or above one percent", () => {
    expect(formatRate(0.0073)).toBe("0.73%");
    expect(formatRate(0.25)).toBe("25.0%");
  });

  it("renders a clean zero", () => {
    expect(formatRate(0)).toBe("0%");
  });
});

describe("formatCount and formatThroughput", () => {
  it("separates thousands", () => {
    expect(formatCount(12_842)).toBe("12,842");
    expect(formatCount(0)).toBe("0");
  });

  it("renders throughput per minute", () => {
    expect(formatThroughput(28.42)).toBe("28.4/min");
  });
});

describe("formatRelative", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");

  it("renders an absent or unparseable timestamp as a dash", () => {
    expect(formatRelative(null, now)).toBe("—");
    expect(formatRelative("not a date", now)).toBe("—");
  });

  it("collapses the last few seconds", () => {
    expect(formatRelative("2026-10-07T11:59:58Z", now)).toBe("just now");
  });

  it("renders an age in the past", () => {
    expect(formatRelative("2026-10-07T11:58:00Z", now)).toBe("2m 00s ago");
    expect(formatRelative("2026-10-07T09:00:00Z", now)).toBe("3h 00m ago");
  });

  it("clamps a future timestamp rather than rendering a negative age", () => {
    // Clock skew between hosts is normal, and "-4s ago" is nonsense.
    expect(formatRelative("2026-10-07T12:00:04Z", now)).toBe("just now");
  });
});

describe("summariseTrace", () => {
  const trace = [
    "Error: Xero returned 429",
    "    at XeroClient.request (src/clients/xero.ts:142:19)",
    "    at async SyncInvoiceJob.handle (src/jobs/sync-invoice.ts:58:5)",
    "    at async JobWorker.run (src/worker.ts:1:1)",
  ].join("\n");

  it("keeps the front of a trace, where the value is", () => {
    expect(summariseTrace(trace, 2)).toBe(
      "Error: Xero returned 429\n    at XeroClient.request (src/clients/xero.ts:142:19)",
    );
  });

  it("returns a short trace unchanged", () => {
    expect(summariseTrace("Error: boom", 3)).toBe("Error: boom");
  });

  it("renders an absent trace as empty, not as the string null", () => {
    expect(summariseTrace(null)).toBe("");
  });

  it("does not escape — escaping belongs at the call site", () => {
    // A formatter that quietly escaped would make double-escaping the
    // default once the theme escapes too.
    expect(summariseTrace("Error: <script>", 1)).toBe("Error: <script>");
  });
});
