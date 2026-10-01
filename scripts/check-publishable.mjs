#!/usr/bin/env node
// Fail if any public workspace package does not yet exist on the registry.
//
//   node scripts/check-publishable.mjs
//
// npm trusted publishing (OIDC) can only publish to a package that already
// exists, because the trusted-publisher config lives on the package. A name
// that has never been published has nothing to attach that config to, so the
// registry answers the publish with a 404.
//
// `pnpm publish -r` is not atomic. Without this check a release containing a
// brand-new package publishes every package ahead of it in the dependency
// order, hits the 404, and stops, leaving the registry holding half of a
// version. `create-mahi` is the worst case: it can go out pinning a version
// of a sibling that never shipped.
//
// Running this before the publish step turns that into a clean refusal with
// nothing written. The fix it asks for is a one-time manual publish of the
// new package (`pnpm publish --access public --no-git-checks` from its
// directory, with a credential that is not OIDC), then adding this repo and
// `release.yml` as its trusted publisher.
//
// Only existence is checked, not the version. Publishing a version that is
// already on the registry is fine: `pnpm publish -r` skips it, which is what
// makes re-running a release safe.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const frameworkDir = join(root, "framework");

/** Where `pnpm publish` would actually write, so the check cannot test a different registry. */
function resolveRegistry() {
  if (process.env.npm_config_registry) return process.env.npm_config_registry;

  try {
    const configured = execFileSync("npm", ["config", "get", "registry"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (configured && configured !== "undefined" && configured !== "null") return configured;
  } catch {
    // npm missing or unreadable config, fall through to the default.
  }

  return "https://registry.npmjs.org/";
}

const registry = resolveRegistry().replace(/\/+$/, "");

const packages = [];
for (const entry of readdirSync(frameworkDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const path = join(frameworkDir, entry.name, "package.json");
  if (!existsSync(path)) continue;
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  if (pkg.private) continue;
  packages.push({ dir: entry.name, name: pkg.name });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolves `"present"` or `"missing"`, or throws when the registry could not
 * be reached. A transient failure (network error, 5xx, 429) must never read
 * as "missing": that would send someone off to manually publish a package
 * that is already there. Only a 404 is treated as an answer.
 *
 * Asks for the abbreviated packument, which is a few KB rather than the full
 * document, and defeats any cache in front of it. A freshly published package
 * can otherwise still 404 against a stale edge for a minute or two.
 */
async function exists(name, { attempts = 3 } = {}) {
  const url = `${registry}/${name.replace("/", "%2F")}`;
  let last;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/vnd.npm.install-v1+json",
          "cache-control": "no-cache",
        },
        cache: "no-store",
      });

      if (response.status === 404) return "missing";
      if (response.ok) return "present";

      last = new Error(`HTTP ${response.status}`);
    } catch (error) {
      last = error;
    }

    if (attempt < attempts) await sleep(attempt * 1000);
  }

  throw new Error(`could not reach the registry for ${name}: ${last?.message ?? "unknown error"}`);
}

let results;
try {
  results = await Promise.all(
    packages.map(async (pkg) => ({ ...pkg, state: await exists(pkg.name) })),
  );
} catch (error) {
  console.error(error.message);
  console.error("\nthe registry was unreachable, so publishability is unknown — not proceeding");
  process.exit(1);
}

const missing = results.filter((r) => r.state === "missing");

if (missing.length === 0) {
  console.log(`all ${results.length} packages exist on ${registry}, publishable`);
  process.exit(0);
}

console.error(
  `${missing.length} package${missing.length === 1 ? " does" : "s do"} not exist on ${registry}:\n`,
);
for (const pkg of missing) console.error(`  ${pkg.name}  (framework/${pkg.dir})`);
console.error(
  [
    "",
    "Trusted publishing cannot create a package. Publish each one manually,",
    "once, with a non-OIDC credential:",
    "",
    ...missing.map(
      (pkg) => `  (cd framework/${pkg.dir} && pnpm publish --access public --no-git-checks)`,
    ),
    "",
    "Use pnpm, not npm: npm does not rewrite `workspace:*` dependencies and",
    "would publish an uninstallable tarball.",
    "",
    "Then add the trusted publisher (repository + release.yml) to each on npm,",
    "and re-run this release.",
  ].join("\n"),
);
process.exit(1);
