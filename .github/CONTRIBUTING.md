# Contributing to Mahi

Thanks for your interest in improving Mahi. This guide covers how to get set up,
what a good pull request looks like, and how releases are cut.

Mahi is still in development and things will change without warning. If you are
looking to *use* the framework rather than contribute to it, start at
[bradietilley.dev/mahi](https://bradietilley.dev/mahi/dev-main) instead.

> Mahi is opinionated on purpose. Following the conventions the framework
> already has is worth more here than a clever local solution, both for the next
> person reading the code and for anyone (human or agent) inferring the rest of a
> change from what is already there.

## Which branch?

Send pull requests to `main`. There are no long-lived release branches yet — the
latest tag is the supported release, and `main` is always the next one.

## Getting set up

You will need Node.js 26 or later and pnpm 9:

```bash
pnpm install
pnpm build
pnpm test
```

This is a pnpm + Turbo monorepo. The framework packages live in `framework/*`
and are published as `@mahiframework/*`; everything else (`docs/`, `scripts/`)
belongs to the repository root.

### Working on one package

Turbo scopes to a single package with `--filter`, and rebuilds its dependencies
first, so you rarely need a full-repo build:

```bash
pnpm --filter @mahiframework/core test
pnpm --filter @mahiframework/http exec vitest                     # watch
pnpm --filter @mahiframework/http exec vitest run tests/router.test.ts
```

Before opening a pull request, run the same checks CI runs:

```bash
pnpm metadata:check     # package metadata is in sync
pnpm version:check      # lockstep versions agree
pnpm build
pnpm pack:check         # tarballs contain only dist, README, LICENSE
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

`pnpm format` applies both ESLint fixes and Prettier.

## Testing the scaffolder

`create-mahi` generates an app that depends on `@mahiframework/*` at published
versions. To scaffold against the working tree instead, use `--link-workspace`
to rewrite them to `workspace:*` and scaffold into `.tmp-scaffold/` (a
gitignored workspace member):

```bash
pnpm --filter create-mahi build
node framework/create-mahi/dist/index.js .tmp-scaffold/demo --no-install --no-git --link-workspace
pnpm install

cd .tmp-scaffold/demo
./artisan key:generate
./artisan migrate
./artisan serve
```

### Integration tests

The MySQL, Postgres, Redis, and SFTP suites skip themselves when no server is
reachable. To run them locally against the same images CI uses:

```bash
pnpm test:integration     # docker compose up, then the full suite with CI_STRICT_MODE=true
pnpm services:down
```

Set `CI_STRICT_MODE=true` yourself when running a single package's suite against
services: it turns an unreachable service into a failure instead of a skip, so a
service that failed to boot can't report green by testing nothing.

## Documentation

Docs live in `docs/` and are published to
[bradietilley.dev/mahi](https://bradietilley.dev/mahi/dev-main). Documentation
changes are pull requests like any other — fix the docs in the same PR as the
code change that made them stale, not in a follow-up.

## Releasing

Releases are cut by maintainers from `main`. Every `@mahiframework/*` package
shares one version and is published together. To cut a release:

```bash
pnpm version:set 0.2.0    # bumps every lockstep package + the create-mahi template pins
pnpm metadata:check && pnpm version:check && pnpm pack:check
git commit -am "release: v0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

The `Release` workflow builds, lints, typechecks, tests, verifies the tag
matches the lockstep version, and runs `pnpm -r publish`, which only publishes
packages whose version is not already on npm, so re-running a release is safe. It
authenticates to npm with trusted publishing (OIDC), so there is no token to
rotate: each package lists this repository and `release.yml` as its trusted
publisher.

## Pull requests

Keep them small and single-purpose. A PR that changes a package and its docs and
its tests is a good PR; a PR that refactors four packages "while in there" is one
that will sit unreviewed.

- Target `main`, with a descriptive title that reads as a summary.
- Explain the benefit to someone building an app on Mahi, not just the mechanics.
- Include tests. A bug fix without a failing-then-passing test is hard to review.
- Update the docs your change makes stale.
- Run `pnpm format:check && pnpm lint && pnpm typecheck` before pushing.

CI runs the service-free checks first (build, lint, typecheck, metadata, SQLite
suites), then the MySQL/Postgres/Redis/SFTP suites and a scaffolder smoke test.
See `.github/PULL_REQUEST_TEMPLATE.md` for the checklist.

## Bug reports

Open an issue using the [bug report template](ISSUE_TEMPLATE/bug_report.yml).
Include the Mahi version, your Node version, the database driver and version if
relevant, and a minimal reproduction — a repository is best, a pasted snippet of
config is next.

## Security vulnerabilities

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## Code of conduct

Participation in this project is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md). By contributing, you agree to
abide by it.
