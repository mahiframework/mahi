import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationException } from "@mahiframework/validation";
import { SettingsCacheResetCommand } from "../src/commands/settings-cache-reset.js";
import { SettingsForgetCommand } from "../src/commands/settings-forget.js";
import { SettingsGetCommand } from "../src/commands/settings-get.js";
import { SettingsListCommand } from "../src/commands/settings-list.js";
import { SettingsSetCommand } from "../src/commands/settings-set.js";
import { UnknownSettingError } from "../src/errors.js";
import { Setting } from "../src/settings-facade.js";
import { captureError, createHarness, makeUser, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;
let written: string[];

beforeEach(async () => {
  harness = await createHarness();
  written = [];
  // `Tui` talks straight to `process.stdout`, so that is the only place
  // the output can be captured. Asserting on it rather than trusting the
  // commands is what makes `settings:get`'s pipeable, bare output a
  // tested contract — a stray label or a JSON quote would break a deploy
  // script that reads it.
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    written.push(String(chunk));

    return true;
  });
});

afterEach(() => {
  harness.cleanup();
  Setting.restore();
  vi.restoreAllMocks();
});

describe("settings:get", () => {
  it("prints a bare value, so it is pipeable", async () => {
    await new SettingsGetCommand(harness.app).handle("import_batch_size");

    // Exactly `100\n` — no indent, no padding, no JSON quotes, nothing a
    // caller has to trim. `$(...)` strips the trailing newline, so this
    // is the value and nothing else.
    expect(written).toEqual(["100\n"]);
  });

  it("prints a string without JSON quotes", async () => {
    await new SettingsGetCommand(harness.app).handle("app_name");

    expect(written).toEqual(["Mahi\n"]);
  });

  it("throws on an unknown key rather than printing a blank line", async () => {
    // A typo in a script must fail rather than read as "unset".
    expect(
      await captureError(new SettingsGetCommand(harness.app).handle("app_nmae")),
    ).toBeInstanceOf(UnknownSettingError);
  });
});

describe("settings:set", () => {
  it("parses the value against the declared type", async () => {
    await new SettingsSetCommand(harness.app).handle("import_feature_enabled", "true");

    // A boolean, not the string "true".
    expect(await harness.registry.get("import_feature_enabled")).toBe(true);
  });

  it("parses a number", async () => {
    await new SettingsSetCommand(harness.app).handle("import_batch_size", "250");

    expect(await harness.registry.get("import_batch_size")).toBe(250);
  });

  it("takes JSON for an array setting", async () => {
    await new SettingsSetCommand(harness.app).handle("allowed_domains", '["a.test","b.test"]');

    expect(await harness.registry.get("allowed_domains")).toEqual(["a.test", "b.test"]);
  });

  it("records a null actor, since a command has no authenticated user", async () => {
    // Attributing an operator's change to a user would be a lie. The
    // null is what says "this came from the command line".
    await new SettingsSetCommand(harness.app).handle("app_name", "From the CLI");

    expect(await harness.registry.isCustomised("app_name")).toBe(true);
  });

  it("still validates the definition's own rules", async () => {
    expect(
      await captureError(new SettingsSetCommand(harness.app).handle("import_batch_size", "99999")),
    ).toBeInstanceOf(ValidationException);
  });

  it("reports an unknown key before trying to parse the value", async () => {
    // So a typo'd key reports itself rather than a confusing parse
    // failure about a type it was never going to have.
    expect(
      await captureError(new SettingsSetCommand(harness.app).handle("nonsense", "x")),
    ).toBeInstanceOf(UnknownSettingError);
  });
});

describe("settings:forget", () => {
  it("reverts a customised setting to its default", async () => {
    await harness.registry.set("app_name", "Acme");

    await new SettingsForgetCommand(harness.app).handle("app_name");

    expect(await harness.registry.get("app_name")).toBe("Mahi");
  });

  it("says so rather than pretending, when nothing was stored", async () => {
    await new SettingsForgetCommand(harness.app).handle("app_name");

    expect(written.join("\n")).toContain("already at its default");
  });

  it("clears a stored value that no longer decodes", async () => {
    // The reason this command exists beyond tidiness: a definition whose
    // `type` changed after a value was written makes `get()` throw, and
    // this is the way out without a hand-written DELETE.
    await harness.registry.set("app_name", "fine");

    await new SettingsForgetCommand(harness.app).handle("app_name");

    expect(await harness.registry.isCustomised("app_name")).toBe(false);
  });
});

describe("settings:list", () => {
  it("lists every declared setting, including ones never stored", async () => {
    await new SettingsListCommand(harness.app).handle();

    const output = written.join("\n");

    expect(output).toContain("app_name");
    expect(output).toContain("import_batch_size");
    expect(output).toContain("branding");
  });

  it("marks which settings differ from their default", async () => {
    await harness.registry.set("app_name", "Acme");

    await new SettingsListCommand(harness.app).handle();

    // The column that distinguishes "a bad default in code" from "a bad
    // row in the database".
    expect(written.join("\n")).toMatch(/app_name.*Acme.*yes/s);
  });

  it("filters to one category", async () => {
    await new SettingsListCommand(harness.app).handle({ category: "import" });

    const output = written.join("\n");

    expect(output).toContain("import_batch_size");
    expect(output).not.toContain("app_name");
  });

  it("filters to customised settings only", async () => {
    await harness.registry.set("app_name", "Acme");

    await new SettingsListCommand(harness.app).handle({ customised: true });

    const output = written.join("\n");

    expect(output).toContain("app_name");
    expect(output).not.toContain("import_batch_size");
  });

  it("includes descriptions when asked", async () => {
    await new SettingsListCommand(harness.app).handle({ verbose: true });

    expect(written.join("\n")).toContain("The application's display name.");
  });

  it("says so for a category nothing is declared in", async () => {
    await new SettingsListCommand(harness.app).handle({ category: "nonexistent" });

    expect(written.join("\n")).toContain('No settings are declared in category "nonexistent"');
  });

  it("says so for an app that declares nothing at all", async () => {
    const empty = await createHarness({ definitions: [] });

    await new SettingsListCommand(empty.app).handle();

    expect(written.join("\n")).toContain("No settings are declared.");

    empty.cleanup();
  });
});

describe("settings:cache-reset", () => {
  it("forgets the cached map", async () => {
    await harness.registry.get("app_name");

    await new SettingsCacheResetCommand(harness.app).handle();

    expect(await harness.store.get("mahi.settings")).toBeUndefined();
  });
});

describe("the facade", () => {
  it("forwards to the bound registry", async () => {
    const user = await makeUser();

    await Setting.set("app_name", "Through the facade", user);

    expect(await Setting.get("app_name")).toBe("Through the facade");
    expect(await Setting.isCustomised("app_name")).toBe(true);
    expect(Setting.has("app_name")).toBe(true);
    expect(Setting.definition("app_name").type).toBe("string");
    expect(Setting.categories()).toContain("import");
  });

  it("forwards all(), setMany() and forget()", async () => {
    await Setting.setMany({ app_name: "A", import_batch_size: 7 });

    expect(await Setting.all()).toMatchObject({ app_name: "A", import_batch_size: 7 });

    await Setting.forget("app_name");

    expect(await Setting.get("app_name")).toBe("Mahi");
  });
});
