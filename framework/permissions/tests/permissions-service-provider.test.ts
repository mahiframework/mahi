import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { ModelCreated, ModelDeleted, ModelSaved, ModelUpdated } from "@mahiframework/database";
import { PermissionsServiceProvider } from "../src/permissions-service-provider.js";
import { PermissionRegistrar } from "../src/permission-registrar.js";
import { PERMISSIONS_TOKEN } from "../src/tokens.js";
import { Role } from "../src/models/role.model.js";
import { Permission } from "../src/models/permission.model.js";
import { InvalidatePermissionCacheListener } from "../src/listeners/invalidate-permission-cache.listener.js";
import { PermissionsCacheResetCommand } from "../src/commands/permissions-cache-reset.js";
import { PermissionsCheckCommand } from "../src/commands/permissions-check.js";
import { PermissionsShowCommand } from "../src/commands/permissions-show.js";
import { assignmentMemo } from "../src/request-cache.js";

let app: Application;
let provider: PermissionsServiceProvider;

beforeEach(() => {
  app = new Application();
  setCurrentApp(app);
  provider = new PermissionsServiceProvider(app);
  provider.register();
});

afterEach(() => clearCurrentApp());

describe("PermissionsServiceProvider", () => {
  it("binds the registrar with working defaults and no config at all", () => {
    // `config.get(...) ?? {}`, not `config.require()`: an app that
    // installs the package and configures nothing should boot.
    expect(app.make<PermissionRegistrar>(PERMISSIONS_TOKEN)).toBeInstanceOf(PermissionRegistrar);
  });

  it("does not clobber config the app already set", () => {
    // `ConfigRepository.merge()` deep-merges INCOMING values last, so
    // contributing defaults that way would overwrite the app's own
    // config rather than layering under it. The provider must not call
    // it, and this is what notices if it starts to.
    const other = new Application();
    setCurrentApp(other);
    other.config.set("permissions", { guard: "api", cache: { key: "acme" } });
    new PermissionsServiceProvider(other).register();

    expect(other.config.get("permissions")).toEqual({ guard: "api", cache: { key: "acme" } });
  });

  it("ships the migration under a name matching its file", () => {
    // The name lands in the `migrations` table and orders execution;
    // drifting from the filename would re-run it for an app that already
    // migrated.
    expect(provider.migrationSources()).toEqual([
      { name: "0001_create_permission_tables", migration: expect.anything() },
    ]);
  });

  it("registers both models, so a queued job can carry one", () => {
    expect(provider.models()).toEqual([Role, Permission]);
  });

  it("registers the three commands", () => {
    expect(provider.commands()).toEqual([
      PermissionsCacheResetCommand,
      PermissionsCheckCommand,
      PermissionsShowCommand,
    ]);
  });

  it("subscribes to the three past-tense model events", () => {
    expect(provider.listeners()).toEqual([
      [ModelCreated, InvalidatePermissionCacheListener],
      [ModelUpdated, InvalidatePermissionCacheListener],
      [ModelDeleted, InvalidatePermissionCacheListener],
    ]);
  });

  it("does not subscribe to ModelSaved, which fires alongside created and updated", () => {
    // Subscribing would double the invalidation work on every write.
    const events = provider.listeners().map(([eventClass]) => eventClass);

    expect(events).not.toContain(ModelSaved);
  });

  it("opens an assignment memo scope in its middleware", async () => {
    // `HttpPipe` is a union with the object form, so the function has to
    // be narrowed before it can be invoked.
    const [pipe] = provider.middleware();

    if (typeof pipe !== "function") {
      throw new Error("Expected the provider to contribute a function pipe.");
    }

    let inside: unknown = "not run";

    await pipe(null as never, () => {
      inside = assignmentMemo();

      return Promise.resolve(null as never);
    });

    expect(inside).toBeInstanceOf(Map);
  });

  it("contributes exactly one pipe", () => {
    expect(provider.middleware()).toHaveLength(1);
  });

  it("registers a gate hook by default", () => {
    const before = vi.fn();
    provider.gates({ before } as never);

    expect(before).toHaveBeenCalledTimes(1);
  });

  it("registers no gate hook when disabled", () => {
    const other = new Application();
    setCurrentApp(other);
    other.config.set("permissions", { gate: false });
    const disabled = new PermissionsServiceProvider(other);
    disabled.register();

    const before = vi.fn();
    disabled.gates({ before } as never);

    expect(before).not.toHaveBeenCalled();
  });
});
