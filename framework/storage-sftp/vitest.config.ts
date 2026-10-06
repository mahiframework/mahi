import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The listing cases walk a tree with bounded concurrency over a real
    // SSH channel: the contract's deep-and-wide tree is 72 sequential
    // `put`s plus the recursive walk, and the slow-link cases deliberately
    // set `concurrency: 2`. That is ~1.3s against an idle server and over
    // 7s on a CI runner where the rest of the monorepo's suites compete
    // for the same machine, so the default 5s fails there while passing
    // everywhere else. Raising it is honest for the same reason it is in
    // `@mahiframework/storage-ftp`: the cost is the protocol's round
    // trips, not a hang worth failing on.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
