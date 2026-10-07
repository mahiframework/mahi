import { describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedResource } from "../src/activity-log-config.js";
import {
  captureAttributes,
  captureChanges,
  capturePlainUpdate,
  isModelInstance,
} from "../src/capture/capture.js";
import { isCapturable, maskRulesFor, maskValue } from "../src/capture/mask.js";
import { capMessage, capPayload, stringify } from "../src/capture/serialize.js";

function resource(overrides: Partial<ResolvedResource> = {}): ResolvedResource {
  return {
    capture: "full",
    actions: new Set(["created", "updated", "deleted", "soft_deleted", "restored"]),
    mask: new Set(),
    only: null,
    except: new Set(),
    ...overrides,
  };
}

/** A stand-in for a model instance, with the three methods capture reads. */
function model(attributes: Record<string, unknown>, changes: Record<string, unknown> = {}) {
  return {
    toObject: () => attributes,
    getChanges: () => changes,
    getOriginal: (key: string) => `old-${key}`,
  };
}

describe("masking", () => {
  const config = resolveConfig({ mask: ["password"] });

  it("unions the model's hidden with the global and per-model masks", () => {
    const rules = maskRulesFor({ hidden: ["secret_note"] }, config.mask, new Set(["phone"]));

    expect([...rules.masked].sort()).toEqual(["password", "phone", "secret_note"]);
    expect(rules.allowed).toBeNull();
  });

  it("lets visible invert hidden, exactly as toJSON() does", () => {
    // When `visible` is non-empty the framework's own serialisation stops
    // consulting `hidden`. Mirroring that is what stops a model using
    // `visible` from leaking through a package that only checked `hidden`.
    const rules = maskRulesFor(
      { hidden: ["secret_note"], visible: ["title"] },
      config.mask,
      new Set(),
    );

    expect(rules.allowed).toEqual(new Set(["title"]));
    expect(rules.masked.has("secret_note")).toBe(false);
    expect(isCapturable("secret_note", rules, null, new Set())).toBe(false);
    expect(isCapturable("title", rules, null, new Set())).toBe(true);
  });

  it("matches names case-insensitively", () => {
    // A security filter a capitalisation defeats is not a filter.
    const rules = maskRulesFor({ hidden: ["Secret_Note"] }, config.mask, new Set());

    expect(rules.masked.has("secret_note")).toBe(true);
  });

  it("replaces a masked value rather than omitting the key", () => {
    // Omitting it would make "this field changed" unknowable, which is
    // exactly what an audit wants to know about a password column.
    const masked = maskValue({ password: "hunter2", title: "x" }, new Set(["password"]), "[m]");

    expect(masked).toEqual({ password: "[m]", title: "x" });
  });

  it("masks a key nested inside a JSON column", () => {
    const masked = maskValue(
      { settings: { integrations: { api_key: "live_abc" } } },
      new Set(["api_key"]),
      "[m]",
    );

    expect(masked).toEqual({ settings: { integrations: { api_key: "[m]" } } });
  });

  it("walks arrays element-wise", () => {
    const masked = maskValue({ keys: [{ token: "a" }, { token: "b" }] }, new Set(["token"]), "[m]");

    expect(masked).toEqual({ keys: [{ token: "[m]" }, { token: "[m]" }] });
  });

  it("replaces a cycle instead of recursing forever", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic["self"] = cyclic;

    expect(maskValue(cyclic, new Set(), "[m]")).toEqual({ name: "root", self: "[circular]" });
  });

  it("stops at the depth cap", () => {
    let deep: Record<string, unknown> = { bottom: true };

    for (let index = 0; index < 12; index += 1) {
      deep = { nested: deep };
    }

    expect(() => maskValue(deep, new Set(), "[m]")).not.toThrow();
    expect(stringify(maskValue(deep, new Set(), "[m]"))).toContain("[truncated]");
  });

  it("leaves a class instance alone rather than walking its internals", () => {
    // A Date is a value, not a bag of attributes. Recursing into one
    // would expose internals as though they were recorded data.
    const date = new Date("2024-01-01T00:00:00.000Z");

    expect(maskValue({ at: date }, new Set(), "[m]")).toEqual({ at: date });
  });
});

describe("only and except", () => {
  const rules = maskRulesFor({}, new Set(), new Set());

  it("except drops an attribute before masking is considered", () => {
    expect(isCapturable("last_seen_at", rules, null, new Set(["last_seen_at"]))).toBe(false);
  });

  it("only acts as a whitelist", () => {
    expect(isCapturable("title", rules, new Set(["title"]), new Set())).toBe(true);
    expect(isCapturable("body", rules, new Set(["title"]), new Set())).toBe(false);
  });
});

describe("captureAttributes", () => {
  const rules = maskRulesFor({ hidden: ["secret"] }, new Set(), new Set());

  it("records names only in columns mode", () => {
    const data = captureAttributes(
      model({ title: "a", secret: "s" }),
      resource({ capture: "columns" }),
      rules,
      "[m]",
    );

    expect(data).toEqual({ attributes: ["title", "secret"] });
  });

  it("records masked values in full mode", () => {
    const data = captureAttributes(model({ title: "a", secret: "s" }), resource(), rules, "[m]");

    expect(data).toEqual({ attributes: { title: "a", secret: "[m]" } });
  });

  it("records nothing at all in none mode", () => {
    // Distinct from an unconfigured model, which writes no row.
    expect(
      captureAttributes(model({ title: "a" }), resource({ capture: "none" }), rules, "[m]"),
    ).toBeNull();
  });
});

describe("captureChanges", () => {
  const rules = maskRulesFor({ hidden: ["password"] }, new Set(), new Set());

  it("records a from/to pair in full mode", () => {
    const data = captureChanges(model({}, { status: "live" }), resource(), rules, "[m]");

    expect(data).toEqual({ changes: { status: { from: "old-status", to: "live" } } });
  });

  it("masks both halves of a sensitive change", () => {
    // Both sides, not just the new value: the old one is just as much a
    // credential as the new one.
    const data = captureChanges(model({}, { password: "new" }), resource(), rules, "[m]");

    expect(data).toEqual({ changes: { password: { from: "[m]", to: "[m]" } } });
  });

  it("records changed names only in columns mode", () => {
    const data = captureChanges(
      model({}, { status: "live", password: "new" }),
      resource({ capture: "columns" }),
      rules,
      "[m]",
    );

    expect(data).toEqual({ changed: ["status", "password"] });
  });
});

describe("capturePlainUpdate", () => {
  const rules = maskRulesFor({}, new Set(), new Set());

  it("degrades to names and flags itself partial, even in full mode", () => {
    // `Model.update(id, values)` hands over a plain object with no
    // `getOriginal()`, so a from/to pair is impossible. Emitting a
    // one-sided change would misrepresent it as one.
    const data = capturePlainUpdate({ id: "1", password: "x" }, resource(), rules, "id");

    expect(data).toEqual({ changed: ["password"], partial: true });
  });

  it("recognises a plain payload as not a model instance", () => {
    expect(isModelInstance({ id: "1", title: "x" })).toBe(false);
    expect(isModelInstance(model({}, {}))).toBe(true);
  });
});

describe("serialisation", () => {
  it("survives a bigint, which JSON.stringify alone throws on", () => {
    // The scaffolded User keys on an auto-increment id, so a user id inside a
    // payload is a bigint in a default app.
    expect(stringify({ user_id: 123n })).toBe('{"user_id":"123"}');
  });

  it("replaces an oversized payload with a marker that keeps the keys", () => {
    // Replaced rather than trimmed: a trimmed payload looks complete and
    // is not, while this one announces its own failure.
    const capped = capPayload({ body: "x".repeat(200), title: "t" }, 64);

    expect(capped.truncated).toBe(true);
    expect(capped.data).toEqual({
      truncated: true,
      reason: "max_data_bytes",
      keys: ["body", "title"],
    });
  });

  it("leaves a payload under the cap untouched", () => {
    const capped = capPayload({ title: "t" }, 1024);

    expect(capped.truncated).toBe(false);
    expect(capped.data).toEqual({ title: "t" });
  });

  it("truncates an over-long message rather than failing the write", () => {
    const capped = capMessage("x".repeat(300), 255);

    expect(capped).toHaveLength(255);
    expect(capped?.endsWith("…")).toBe(true);
  });

  it("leaves a short message alone", () => {
    expect(capMessage("short", 255)).toBe("short");
    expect(capMessage(null, 255)).toBeNull();
  });
});

describe("resolveConfig", () => {
  it("treats a bare string as a capture mode", () => {
    const config = resolveConfig({ resources: { Post: "full" } });

    expect(config.resources.get("Post")?.capture).toBe("full");
  });

  it("defaults capture to columns, the safe half", () => {
    const config = resolveConfig({ resources: { Post: {} } });

    expect(config.resources.get("Post")?.capture).toBe("columns");
  });

  it("ships a sensible default mask", () => {
    const config = resolveConfig();

    expect(config.mask.has("password")).toBe(true);
    expect(config.mask.has("token")).toBe(true);
  });

  it("treats context: false as no context", () => {
    expect(resolveConfig({ context: false }).context).toBeNull();
  });
});
