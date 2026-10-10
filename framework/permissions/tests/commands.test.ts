import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DB, Relation } from "@mahiframework/database";
import { PermissionsCacheResetCommand } from "../src/commands/permissions-cache-reset.js";
import { PermissionsCheckCommand } from "../src/commands/permissions-check.js";
import { Permissions } from "../src/permissions-facade.js";
import { PERMISSIONS_TOKEN } from "../src/tokens.js";
import {
  createHarness,
  LegacyAccount,
  makeLegacyAccount,
  makeUser,
  User,
  type Harness,
} from "./__fixtures__/test-app.js";

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

  it("fails when stored model_ids are not the shape assigneeKey now says", async () => {
    // 🚨 Changing `assigneeKey` on a populated install is not a
    // migration: the column's type and the guard's expectation come from
    // that one setting, and nothing rewrites the rows. They are left
    // intact and unreachable, which has to be reported rather than
    // discovered as "this user lost their roles".
    Relation.morphMap({ User: () => User as never });

    const role = await harness.registrar.createRole("admin");
    const user = await makeUser();

    await harness.registrar.assignRole(user, "admin");

    // The app flips to uuid afterwards, as an operator editing config
    // would. The bigint rows are still there. The registrar is a
    // singleton that read the old config, so it is dropped too — a real
    // deploy gets a fresh process.
    harness.app.config.set("permissions", { guard: "web", assigneeKey: "uuid" });
    harness.app.forgetInstance(PERMISSIONS_TOKEN);
    Permissions.restore();

    const error = vi.spyOn(harness.app.logger, "error").mockImplementation(() => {});

    await new PermissionsCheckCommand(harness.app).handle();

    expect(process.exitCode).toBe(1);
    expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toContain("model_has_roles");
    expect(role.id).toBeDefined();
  });

  it("passes when the stored model_ids match a uuid assigneeKey", async () => {
    const uuid = await createHarness({ assigneeKey: "uuid" });

    Relation.morphMap({ LegacyAccount: () => LegacyAccount as never });

    try {
      await uuid.registrar.createRole("admin");
      await uuid.registrar.assignRole(await makeLegacyAccount(), "admin");

      await new PermissionsCheckCommand(uuid.app).handle();

      expect(process.exitCode).toBeUndefined();
    } finally {
      uuid.cleanup();
    }
  });
});
