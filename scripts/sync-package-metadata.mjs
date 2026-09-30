#!/usr/bin/env node
// Stamps the shared publishing fields into every workspace package so that
// `npm pack` ships a consistent, minimal, legally-usable tarball. Run with
// `--check` in CI to fail (instead of write) when anything drifts.
//
//   node scripts/sync-package-metadata.mjs          # write
//   node scripts/sync-package-metadata.mjs --check  # verify only
//
// Per-package `description`/`keywords` live in DESCRIPTIONS below; everything
// else (license, repository, engines, publishConfig, files, sideEffects) is
// identical across the workspace and derived here.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const frameworkDir = join(root, "framework");
const rootLicense = readFileSync(join(root, "LICENSE"), "utf8");

const REPO_URL = "https://github.com/mahiframework/mahi";
const HOMEPAGE = "https://github.com/mahiframework/mahi#readme";
const LICENSE = "MIT";
const AUTHOR = "Bradie Tilley";
const ENGINES = { node: ">=26" };
// `tsc -b` never deletes outputs for removed sources; prune them after every
// build so `files: ["dist"]` can't ship a stale module.
const BUILD_SCRIPT = "tsc -b && node ../../scripts/prune-dist.mjs";

// Per-package description + keywords. `create-mahi` keeps its own description.
const DESCRIPTIONS = {
  "@mahiframework/auth": {
    description:
      "Authentication — session and token guards, password brokers, and user providers for Mahi.",
    keywords: ["mahi", "auth", "authentication", "session", "token"],
  },
  "@mahiframework/authorization": {
    description: "Authorization — gates, policies, and ability checks for Mahi.",
    keywords: ["mahi", "authorization", "gate", "policy", "abilities"],
  },
  "@mahiframework/broadcasting": {
    description: "Broadcasting — event broadcasting over WebSocket and pub/sub channels for Mahi.",
    keywords: ["mahi", "broadcasting", "websocket", "pubsub", "realtime"],
  },
  "@mahiframework/cache": {
    description:
      "Cache — a unified cache API over array, file, and Redis stores, with atomic locks, for Mahi.",
    keywords: ["mahi", "cache", "store", "lock", "redis"],
  },
  "@mahiframework/cli": {
    description: "Console — the artisan-style command kernel and code generators for Mahi.",
    keywords: ["mahi", "cli", "console", "commands", "artisan"],
  },
  "@mahiframework/core": {
    description:
      "Core — the application container, service providers, lifecycle, config, and logging for Mahi.",
    keywords: ["mahi", "core", "container", "ioc", "framework"],
  },
  "@mahiframework/database": {
    description: "Database — the query builder, migrations, and Eloquent-style ORM for Mahi.",
    keywords: ["mahi", "database", "orm", "query-builder", "migrations"],
  },
  "@mahiframework/datetime": {
    description: "Dates & times — an immutable, timezone-aware date/time value type for Mahi.",
    keywords: ["mahi", "datetime", "date", "time", "timezone"],
  },
  "@mahiframework/encryption": {
    description: "Encryption — authenticated AES-GCM encryption and keyed signing for Mahi.",
    keywords: ["mahi", "encryption", "aes-gcm", "signing", "crypto"],
  },
  "@mahiframework/events": {
    description: "Events — a synchronous event dispatcher and listener registry for Mahi.",
    keywords: ["mahi", "events", "dispatcher", "listeners", "pubsub"],
  },
  "@mahiframework/facades": {
    description: "Facades — static proxies over container-resolved services for Mahi.",
    keywords: ["mahi", "facades", "container", "proxy"],
  },
  "@mahiframework/health": {
    description: "Health — application health checks and readiness reporting for Mahi.",
    keywords: ["mahi", "health", "healthcheck", "readiness"],
  },
  "@mahiframework/http-client": {
    description: "HTTP client — a fluent, retryable HTTP client with fakes for Mahi.",
    keywords: ["mahi", "http-client", "fetch", "retry", "request"],
  },
  "@mahiframework/http": {
    description: "HTTP — the router, request/response, middleware, and kernel for Mahi.",
    keywords: ["mahi", "http", "router", "middleware", "kernel"],
  },
  "@mahiframework/mail": {
    description: "Mail — mailables and transports for sending email from Mahi.",
    keywords: ["mahi", "mail", "email", "mailable", "smtp"],
  },
  "@mahiframework/notifications": {
    description: "Notifications — multi-channel notifications for Mahi.",
    keywords: ["mahi", "notifications", "notify", "channels"],
  },
  "@mahiframework/pipeline": {
    description: "Pipeline — pass an object through a series of stages, for Mahi.",
    keywords: ["mahi", "pipeline", "middleware", "stages"],
  },
  "@mahiframework/process": {
    description: "Process — a fluent wrapper for spawning and managing child processes, for Mahi.",
    keywords: ["mahi", "process", "child-process", "exec", "spawn"],
  },
  "@mahiframework/queue": {
    description:
      "Queues — background job dispatch and workers over sync, database, and Redis drivers, for Mahi.",
    keywords: ["mahi", "queue", "jobs", "worker", "background"],
  },
  "@mahiframework/redis": {
    description:
      "Redis — a shared Redis connection with cache, queue, and broadcast adapters, for Mahi.",
    keywords: ["mahi", "redis", "cache", "queue", "pubsub"],
  },
  "@mahiframework/schedule": {
    description: "Scheduling — a cron-style task scheduler with overlap protection, for Mahi.",
    keywords: ["mahi", "schedule", "cron", "scheduler", "tasks"],
  },
  "@mahiframework/snowflake": {
    description: "Snowflake — distributed, time-sortable unique ID generation for Mahi.",
    keywords: ["mahi", "snowflake", "id", "unique", "distributed"],
  },
  "@mahiframework/storage": {
    description: "Storage — a filesystem abstraction over local and cloud disks for Mahi.",
    keywords: ["mahi", "storage", "filesystem", "disk", "files"],
  },
  "@mahiframework/storage-sftp": {
    description: "Storage (SFTP) — an SFTP storage driver for Mahi, for files on a remote host.",
    keywords: ["mahi", "storage", "sftp", "ssh", "remote"],
  },
  "@mahiframework/testing": {
    description: "Testing — test helpers, fakes, and assertions for Mahi applications.",
    keywords: ["mahi", "testing", "fakes", "assertions", "test"],
  },
  "@mahiframework/tui": {
    description: "TUI — interactive terminal prompts, spinners, and progress bars for Mahi.",
    keywords: ["mahi", "tui", "terminal", "prompts", "cli"],
  },
  "@mahiframework/validation": {
    description: "Validation — a rule-based validator for Mahi.",
    keywords: ["mahi", "validation", "validator", "rules"],
  },
};

// Package → docs/<slug> for the README "documentation" link, where one exists.
const DOC_SLUGS = {
  "@mahiframework/auth": "authentication",
  "@mahiframework/authorization": "authorization",
  "@mahiframework/broadcasting": "broadcasting",
  "@mahiframework/cache": "cache",
  "@mahiframework/cli": "console",
  "@mahiframework/database": "database",
  "@mahiframework/datetime": "datetime",
  "@mahiframework/encryption": "encryption",
  "@mahiframework/events": "events",
  "@mahiframework/health": "health",
  "@mahiframework/http-client": "http-client",
  "@mahiframework/http": "routing",
  "@mahiframework/mail": "mail",
  "@mahiframework/notifications": "notifications",
  "@mahiframework/queue": "queues",
  "@mahiframework/redis": "redis",
  "@mahiframework/schedule": "scheduling",
  "@mahiframework/storage": "storage",
  "@mahiframework/storage-sftp": "storage",
  "@mahiframework/testing": "testing",
  "@mahiframework/validation": "validation",
};

let hadDrift = false;
const check = process.argv.includes("--check");

for (const entry of readdirSync(frameworkDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const pkgPath = join(frameworkDir, entry.name, "package.json");
  if (!existsSync(pkgPath)) continue;

  const original = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(original);

  const isPrivate = pkg.private === true;

  // Fields shared by every publishable package.
  pkg.license ??= LICENSE;
  pkg.author ??= AUTHOR;
  // Owned outright, not defaulted: npm validates `repository.url` against the
  // provenance claim, so a stale URL (an org transfer, say) fails the publish.
  pkg.homepage = HOMEPAGE;
  pkg.repository = {
    type: "git",
    url: `git+${REPO_URL}.git`,
    directory: `framework/${entry.name}`,
  };
  pkg.bugs = { url: `${REPO_URL}/issues` };
  pkg.engines = { ...ENGINES, ...pkg.engines };
  pkg.engines.node = ENGINES.node;
  pkg.sideEffects ??= false;
  pkg.scripts ??= {};
  pkg.scripts.build = BUILD_SCRIPT;

  // create-mahi ships a template dir and its own files/description; leave those.
  if (entry.name !== "create-mahi") {
    const meta = DESCRIPTIONS[pkg.name];
    if (meta) {
      pkg.description ??= meta.description;
      if (!pkg.keywords) pkg.keywords = meta.keywords;
    }
    pkg.files = ["dist", "README.md", "LICENSE"];
  }

  if (!isPrivate) {
    pkg.publishConfig ??= { access: "public" };
  }

  const next = JSON.stringify(pkg, null, 2) + "\n";
  if (next !== original) {
    hadDrift = true;
    if (check) {
      console.error(`drift: ${pkg.name} (package.json)`);
    } else {
      writeFileSync(pkgPath, next);
      console.log(`stamped: ${pkg.name}`);
    }
  }

  // Every published tarball declares README.md + LICENSE in `files`; make sure
  // both actually exist so the pack doesn't ship a broken manifest.
  const pkgDir = join(frameworkDir, entry.name);
  const licensePath = join(pkgDir, "LICENSE");
  if (!existsSync(licensePath) || readFileSync(licensePath, "utf8") !== rootLicense) {
    hadDrift = true;
    if (check) console.error(`drift: ${pkg.name} (LICENSE)`);
    else writeFileSync(licensePath, rootLicense);
  }

  const readmePath = join(pkgDir, "README.md");
  if (!existsSync(readmePath)) {
    hadDrift = true;
    const desc = pkg.description ?? "";
    const docSlug = DOC_SLUGS[pkg.name];
    const docLink = docSlug
      ? `\n\nSee the [documentation](${REPO_URL}/tree/main/docs/${docSlug}).\n`
      : "\n";
    const body = `# ${pkg.name}\n\n${desc}\n\nPart of the [Mahi](${REPO_URL}) framework.${docLink}`;
    if (check) console.error(`drift: ${pkg.name} (README.md missing)`);
    else writeFileSync(readmePath, body);
  }
}

if (check && hadDrift) {
  console.error("\npackage metadata is out of sync — run `node scripts/sync-package-metadata.mjs`");
  process.exit(1);
}
if (!hadDrift) console.log("package metadata already in sync");
