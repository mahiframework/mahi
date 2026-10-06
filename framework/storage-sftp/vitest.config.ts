import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The listing cases walk a tree over a real SSH channel, one `readdir`
    // per directory on top of one `put` per file: the contract's
    // deep-and-wide tree is 72 files across 72 directories, and the
    // slow-link cases deliberately bound the pool to `concurrency: 2`.
    //
    // Every round trip is latency the protocol charges, so the wall clock
    // tracks how contended the machine is rather than how much work the
    // driver does. Measured: the "far deeper" case is 667ms against an
    // idle server and 15.3s on a CI runner sharing a box with the rest of
    // the monorepo's suites — ~23x. The deep-and-wide contract case is
    // 1.3s locally, which lands right on top of a 30s limit, so 30s is
    // only just too small and the default 5s was never going to hold.
    //
    // 120s is deliberately far above the ~30s that slowdown implies,
    // because the thing being bounded is contention on a shared runner
    // and a limit sized to the last measurement is just the next flake.
    // These are integration tests gated behind a reachable server; a real
    // hang is caught by the job timeout, not by this.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
