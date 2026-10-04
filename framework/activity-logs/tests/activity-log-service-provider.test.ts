import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import {
  ModelCreated,
  ModelDeleted,
  ModelRestored,
  ModelUpdated,
  Relation,
  type AnyModelClass,
} from "@mahiframework/database";
import { AuthEvent } from "@mahiframework/auth";
import { Request } from "@mahiframework/http";
import { ActivityLogServiceProvider } from "../src/activity-log-service-provider.js";
import { ActivityLogsCheckCommand } from "../src/commands/activity-logs-check.js";
import { ActivityLogsPruneCommand } from "../src/commands/activity-logs-prune.js";
import { ActivityLog } from "../src/models/activity-log.model.js";
import { ACTIVITY_LOG_TOKEN } from "../src/tokens.js";
import type { ActivityLogger } from "../src/activity-logger.js";

describe("ActivityLogServiceProvider", () => {
  let app: Application;
  let provider: ActivityLogServiceProvider;

  beforeEach(() => {
    app = new Application();
    setCurrentApp(app);
    provider = new ActivityLogServiceProvider(app);
    provider.register();
  });

  afterEach(() => clearCurrentApp());

  it("binds the logger with working defaults and no config at all", () => {
    // An app that installs the package and configures nothing must boot.
    // Hence `config.get`, not `config.require`.
    const logger = app.make<ActivityLogger>(ACTIVITY_LOG_TOKEN);

    expect(logger.settings.enabled).toBe(true);
    expect(logger.settings.resources.size).toBe(0);
    expect(logger.settings.maskWith).toBe("[masked]");
  });

  it("does not clobber config the app already set", () => {
    // The ordering that matters: an app's `set()` runs in bootstrap.ts
    // before any `register()`. A package contributing defaults with
    // `config.merge()` would overwrite this, because merge puts the
    // incoming values last.
    const configured = new Application();
    setCurrentApp(configured);
    configured.config.set("activity-logs", { enabled: false, maskWith: "***" });
    new ActivityLogServiceProvider(configured).register();

    const logger = configured.make<ActivityLogger>(ACTIVITY_LOG_TOKEN);
    expect(logger.settings.enabled).toBe(false);
    expect(logger.settings.maskWith).toBe("***");
  });

  it("subscribes to the four past-tense model classes and the AuthEvent base", () => {
    const registered = provider.listeners().map(([eventClass]) => eventClass);

    // Individually, not via a "model.*" pattern: the pattern would also
    // match `retrieved`, which fires on every row read.
    expect(registered).toContain(ModelCreated);
    expect(registered).toContain(ModelUpdated);
    expect(registered).toContain(ModelDeleted);
    expect(registered).toContain(ModelRestored);
    // One entry for all fourteen auth events, which only works because
    // `listen()` accepts an abstract matcher.
    expect(registered).toContain(AuthEvent);
    expect(registered).toHaveLength(5);
  });

  it("does not subscribe to ModelSaved, which would double every row", async () => {
    const { ModelSaved } = await import("@mahiframework/database");

    expect(provider.listeners().map(([eventClass]) => eventClass)).not.toContain(ModelSaved);
  });

  it("ships the migration under a name matching its file", () => {
    expect(provider.migrationSources()).toEqual([
      { name: "0001_create_activity_logs_table", migration: expect.anything() },
    ]);
  });

  it("registers the model for job serialisation", () => {
    expect(provider.models()).toEqual([ActivityLog as unknown as AnyModelClass]);
  });

  it("ships both commands", () => {
    expect(provider.commands()).toEqual([ActivityLogsPruneCommand, ActivityLogsCheckCommand]);
  });

  describe("the context pipe", () => {
    it("seeds ip and user agent when the request has them", async () => {
      const [pipe] = provider.middleware();
      const request = Request.create(
        "/",
        "GET",
        {},
        {
          headers: { "user-agent": "probe/1.0" },
          ip: "203.0.113.7",
        },
      );

      await (pipe as (r: Request, next: (r: Request) => unknown) => unknown)(request, (r) => r);

      expect(app.context.get("user_agent")).toBe("probe/1.0");
      expect(app.context.get("ip")).toBe("203.0.113.7");
    });

    it("omits a key rather than writing null when the value is absent", async () => {
      // `request.ip()` is undefined under in-process dispatch, so both
      // values are optional and a missing one must not become a null.
      const [pipe] = provider.middleware();

      await (pipe as (r: Request, next: (r: Request) => unknown) => unknown)(
        Request.create("/"),
        (r) => r,
      );

      expect(app.context.has("user_agent")).toBe(false);
      expect(app.context.has("ip")).toBe(false);
    });
  });
});

describe("activity-logs:check", () => {
  let app: Application;
  const logged: Array<{ level: string; message: string }> = [];

  beforeEach(() => {
    app = new Application();
    setCurrentApp(app);
    logged.length = 0;

    for (const level of ["info", "warning", "error"] as const) {
      Object.defineProperty(app.logger, level, {
        value: (message: string) => void logged.push({ level, message }),
        configurable: true,
      });
    }
  });

  afterEach(() => {
    Relation.resetMorphMap();
    process.exitCode = 0;
    clearCurrentApp();
  });

  function check(config: Record<string, unknown>): ActivityLogsCheckCommand {
    app.config.set("activity-logs", config);
    new ActivityLogServiceProvider(app).register();

    return new ActivityLogsCheckCommand(app);
  }

  it("errors on a resource key matching no registered model", async () => {
    // The price of keying by morph alias: a typo is otherwise silent, and
    // looks exactly like working config.
    await check({ resources: { Posts: "full" } }).handle();

    expect(logged.some((entry) => entry.level === "error" && entry.message.includes("Posts"))).toBe(
      true,
    );
    expect(process.exitCode).toBe(1);
  });

  it("errors when the package's own table is configured", async () => {
    await check({ resources: { ActivityLog: "full" } }).handle();

    expect(process.exitCode).toBe(1);
  });

  it("warns on full capture with nothing declared sensitive", async () => {
    class Thing {
      static morphAlias(): string {
        return "Thing";
      }
      static hidden: string[] = [];
      static visible: string[] = [];
    }
    Relation.morphMap({ Thing: () => Thing as unknown as AnyModelClass });

    await check({ resources: { Thing: "full" } }).handle();

    // The closest available substitute for the encrypted-cast check the
    // framework cannot do, since no encrypted cast exists.
    expect(logged.some((entry) => entry.level === "warning")).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("passes a model that declares hidden columns", async () => {
    class Guarded {
      static morphAlias(): string {
        return "Guarded";
      }
      static hidden = ["password"];
      static visible: string[] = [];
    }
    Relation.morphMap({ Guarded: () => Guarded as unknown as AnyModelClass });

    await check({ resources: { Guarded: "full" } }).handle();

    expect(logged.some((entry) => entry.level === "warning")).toBe(false);
    expect(process.exitCode).toBe(0);
  });
});
