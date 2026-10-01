# Security Policy

**PLEASE DON'T DISCLOSE SECURITY-RELATED ISSUES PUBLICLY. [SEE BELOW](#reporting-a-vulnerability).**

Mahi is pre-1.0 and under active development. It is not yet considered
production-ready, and public APIs, package layout, and defaults may change
without notice.

## Supported Versions

Every `@mahiframework/*` package is published from one lockstep version and
released together, so there is only ever one line to support: the latest release.

| Version | Supported |
| ------- | --------- |
| Latest release (`@mahiframework/*@latest`) | Yes |
| Anything older | No |

Security fixes land on `main` and ship in the next release. There are no
backports to older versions; upgrade to the latest release.

## Reporting a Vulnerability

Report privately through GitHub's security advisory flow:

**https://github.com/mahiframework/mahi/security/advisories/new**

That opens a private report visible only to you and the maintainers, which is
where you should include proof-of-concept code, affected package versions, and
any suggested remediation. If private advisory reporting is unavailable to you,
email the maintainer instead rather than opening an issue or a public discussion.

Please do not:

- open a public issue or pull request for a vulnerability
- post about it publicly before a fix has shipped
- test against infrastructure you do not own, or access data you are not
  authorised to access

What helps you most:

- the affected package and version (`pnpm why @mahiframework/core`)
- Node.js version, and the database/cache/queue drivers in use
- a minimal reproduction, ideally against `main`
- whether the issue is exploitable by a remote unauthenticated attacker, or only
  by an authenticated one with specific privileges

You can expect an acknowledgement within a few days and a fix or a plan for one
once the report is confirmed. Reporters are credited in the advisory unless they
ask not to be.

## Scope

In scope: the code in this repository, published `@mahiframework/*` packages, and
the app template shipped by `@mahiframework/create-mahi`.

Out of scope, unless the vulnerability is in Mahi's own code: vulnerabilities in
dependencies (report those upstream — `pnpm audit` will point at the package),
misconfiguration of a consuming application, and issues in PHP-ecosystem
tooling, since this is a TypeScript framework with no PHP runtime.
