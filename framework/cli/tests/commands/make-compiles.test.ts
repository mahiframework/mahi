import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Application } from "@mahiframework/core";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { MakeModelCommand } from "../../src/commands/make/make-model.js";
import { MakeFactoryCommand } from "../../src/commands/make/make-factory.js";
import { MakeEventCommand } from "../../src/commands/make/make-event.js";
import { MakeListenerCommand } from "../../src/commands/make/make-listener.js";
import { MakeJobCommand } from "../../src/commands/make/make-job.js";
import { MakeSeederCommand } from "../../src/commands/make/make-seeder.js";
import { MakePolicyCommand } from "../../src/commands/make/make-policy.js";
import { MakeResourceCommand } from "../../src/commands/make/make-resource.js";
import { MakeRequestCommand } from "../../src/commands/make/make-request.js";
import { MakeControllerCommand } from "../../src/commands/make/make-controller.js";
import { MakeMiddlewareCommand } from "../../src/commands/make/make-middleware.js";
import { MakeCommandCommand } from "../../src/commands/make/make-command.js";
import { MakeNotificationCommand } from "../../src/commands/make/make-notification.js";
import { MakeMailCommand } from "../../src/commands/make/make-mail.js";
import { MakeProviderCommand } from "../../src/commands/make-provider.js";

/**
 * The strongest guard against a generator emitting code that does not
 * compile (G1 was exactly that: `make:listener` imported a type
 * `@mahiframework/events` does not export). Every unit test above only string-matches
 * the output; this one actually type-checks it.
 *
 * It scaffolds a small app tree, writes a tsconfig whose `paths` map
 * `@mahiframework/*` to each package's built `dist`, and runs `tsc --noEmit`. It
 * therefore requires the workspace to be built first, which the monorepo's
 * `test` task depends on, and is skipped (not failed) if a required `dist`
 * is missing, so a bare `vitest` in one package without a full build does
 * not report a spurious failure.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const frameworkDir = path.resolve(here, "../../../"); // .../framework
const repoRoot = path.resolve(frameworkDir, ".."); // repo root

const MAHI_PACKAGES = [
  "core",
  "events",
  "datetime",
  "database",
  "http",
  "mail",
  "notifications",
  "queue",
  "snowflake",
  "authorization",
  "cli",
  "tui",
];

function distExists(): boolean {
  return MAHI_PACKAGES.every((p) => existsSync(path.join(frameworkDir, p, "dist", "index.d.ts")));
}

function tsconfig(): string {
  const paths: Record<string, string[]> = {};

  for (const p of MAHI_PACKAGES) {
    paths[`@mahiframework/${p}`] = [path.join(frameworkDir, p, "dist", "index.d.ts")];
  }

  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2022"],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        esModuleInterop: true,
        types: ["node"],
        typeRoots: [path.join(repoRoot, "node_modules", "@types")],
        // No `baseUrl`. Every value in `paths` is already absolute (see
        // above), so there was nothing for it to resolve against, and
        // TypeScript 6 deprecates it — emitting TS5101 here, which this
        // test correctly reported as generated code failing to compile.
        paths,
      },
      include: ["**/*.ts"],
    },
    null,
    2,
  );
}

describe("generated code type-checks", () => {
  let dir: string;
  const app = new Application();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "make-compile-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(!distExists())(
    "every make:* output passes tsc --noEmit",
    async () => {
      const models = path.join(dir, "src", "models");
      const factories = path.join(dir, "database", "factories");
      await mkdir(models, { recursive: true });
      await mkdir(factories, { recursive: true });

      // A model + its factory (the factory imports the model relatively via
      // `../../src/models/...`, which is why the tree layout matters here).
      await new MakeModelCommand(app).handle("post", { dir: models });
      await new MakeFactoryCommand(app).handle("post", { dir: factories });
      await new MakeEventCommand(app).handle("post-created", { dir: path.join(dir, "src/events") });
      await new MakeListenerCommand(app).handle("log-post-created", {
        dir: path.join(dir, "src/listeners"),
      });
      await new MakeJobCommand(app).handle("send-email", { dir: path.join(dir, "src/jobs") });
      await new MakeSeederCommand(app).handle("database", {
        dir: path.join(dir, "database/seeders"),
      });
      await new MakePolicyCommand(app).handle("post", { dir: path.join(dir, "src/policies") });
      await new MakeResourceCommand(app).handle("post", {
        dir: path.join(dir, "src/http/resources"),
      });
      await new MakeRequestCommand(app).handle("create-post", {
        dir: path.join(dir, "src/http/requests"),
      });
      await new MakeControllerCommand(app).handle("post", {
        dir: path.join(dir, "src/http/controllers"),
      });
      await new MakeMiddlewareCommand(app).handle("ensure-admin", {
        dir: path.join(dir, "src/http/middleware"),
      });
      await new MakeCommandCommand(app).handle("send-emails", {
        dir: path.join(dir, "src/commands"),
      });
      await new MakeNotificationCommand(app).handle("invoice-paid", {
        dir: path.join(dir, "src/notifications"),
      });
      await new MakeMailCommand(app).handle("welcome", { dir: path.join(dir, "src/mail") });
      await new MakeProviderCommand(app).handle("blog", { dir: path.join(dir, "src/providers") });

      await writeFile(path.join(dir, "tsconfig.json"), tsconfig());

      const tsc = path.join(repoRoot, "node_modules", ".bin", "tsc");
      try {
        execFileSync(tsc, ["--noEmit", "-p", "tsconfig.json"], {
          cwd: dir,
          stdio: "pipe",
          encoding: "utf8",
        });
      } catch (error) {
        const err = error as { stdout?: string; stderr?: string };
        throw new Error(
          `Generated code failed to type-check:\n${err.stdout ?? ""}${err.stderr ?? ""}`,
        );
      }
    },
    60_000,
  );
});
