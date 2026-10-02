import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // FTP carries one command per connection, so the driver serialises
    // every operation (see `FtpConnection`). The contract's deep-and-wide
    // tree case is ~150 sequential round trips, which is comfortably under
    // a second against an idle server and several times that when the rest
    // of the monorepo's suites are competing for the same machine. The
    // default 5s is a flake under `turbo run test --concurrency=4`, and
    // raising it is honest: the sequential cost is the protocol's, not a
    // hang worth failing on.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
