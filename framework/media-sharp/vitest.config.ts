import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Every suite here decodes and re-encodes real images through
    // libvips. A full-size fixture is fast, but the decompression-bomb
    // case deliberately allocates, so the default 5s is tight on a cold
    // runner.
    testTimeout: 30_000,
  },
});
