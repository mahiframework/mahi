import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DB, Relation } from "@mahiframework/database";
import { PermissionsCacheResetCommand } from "../src/commands/permissions-cache-reset.js";
import { PermissionsCheckCommand } from "../src/commands/permissions-check.js";
import { Permissions } from "../src/permissions-facade.js";
import { createHarness, makeUser, User, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(() => {
  harness.cleanup();
  Permissions.restore();
  process.exitCode = undefined;
});

describe("permissions:cache-reset", () => {
  it("forgets the cached map", async () => {
    await harness.registrar.createRole("admin");
    await harness.registrar.map();

    await new PermissionsCacheResetCommand(harness.app).handle();

    expect(await harness.store.get("mahi.permissions")).toBeUndefined();
  });
});

describe("permissions:check", () => {
  it("passes for a clean install with nothing defined", async () => {
    await new PermissionsCheckCommand(harness.app).handle();

    expect(process.exitCode).toBeUndefined();
  });

  it("passes when every assigned model_type resolves", async () => {
    Relation.morphMap({ User: () => User as never });
    await harness.registrar.createRole("admin");
    const user = await makeUser();
    await harness.registrar.assignRole(user, "admin");

    await new PermissionsCheckCommand(harness.app).handle();

    expect(process.exitCode).toBeUndefined();
  });

  it("fails on an assignment naming no registered model", async () => {
    // The rot this command exists to catch: assignment rows store a morph
    // alias, and `morphAlias()` falls back to the TABLE NAME, so renaming
    // a table orphans every row that named the old one — silently.
    const role = await harness.registrar.createRole("admin");
    await DB.table("model_has_roles").insert({
      role_id: role.id,
      model_type: "RenamedAwayModel",
      model_id: 1n,
    });

    const error = vi.spyOn(harness.app.logger, "error").mockImplementation(() => {});

    await new PermissionsCheckCommand(harness.app).handle();

    expect(process.exitCode).toBe(1);
    expect(error.mock.calls[0]?.[0]).toContain("RenamedAwayModel");
  });

  it("fails on a role using a guard that is not configured", async () => {
    // `guard_name` is NOT NULL with no wildcard, so a role created under
    // a guard later renamed in config/auth.ts can never satisfy a check
    // again.
    harness.app.config.set("auth", { guards: { web: {} } });
    await harness.registrar.createRole("admin", { guard: "mobile" });

    const error = vi.spyOn(harness.app.logger, "error").mockImplementation(() => {});

    await new PermissionsCheckCommand(harness.app).handle();

    expect(process.exitCode).toBe(1);
    expect(error.mock.calls[0]?.[0]).toContain("mobile");
  });

  it("skips the guard check when auth is not configured at all", async () => {
    // Nothing to validate against; reporting every guard as unknown would
    // be noise, not a finding.
    await harness.registrar.createRole("admin", { guard: "mobile" });

    await new PermissionsCheckCommand(harness.app).handle();

    expect(process.exitCode).toBeUndefined();
  });
});
