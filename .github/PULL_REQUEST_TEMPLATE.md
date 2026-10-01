<!--
Mahi is pre-1.0, so most pull requests go to `main`. Please read
https://github.com/mahiframework/mahi/blob/main/.github/CONTRIBUTING.md before
opening one.

Pull requests without a descriptive title, a description of the benefit, or
tests will be sent back.

Please describe the benefit to someone building an app on Mahi, why it does not
break existing behaviour, and why it makes building applications easier.
-->

## What does this change?

<!-- One or two sentences. If this fixes an issue, add "Closes #123". -->

## Why?

<!--
Describe the benefit to an end user of the framework. Not the mechanics of the
diff — the reason it exists. "Adds a `retryUntil()` to queued jobs" is the
mechanics; "a retried job can now stop instead of looping forever" is the reason.
-->

## How?

<!-- Anything a reviewer needs to know to follow the diff: design trade-offs, alternatives you rejected, new configuration or environment variables, anything left deliberately out of scope. -->

## Checklist

- [ ] Tests added or updated
- [ ] Docs updated in [`docs/`](../docs)
- [ ] `pnpm format:check && pnpm lint && pnpm typecheck` passes locally
- [ ] `pnpm test` passes (or the skipped suites are explained above)
- [ ] New public API has JSDoc on the exported symbols
