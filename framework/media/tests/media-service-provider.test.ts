import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MediaFile } from "../src/models/media-file.model.js";
import { MediaManager } from "../src/media-manager.js";
import { MEDIA_TOKEN } from "../src/tokens.js";
import { createHarness, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe("MediaServiceProvider", () => {
  it("binds the manager with no config at all", () => {
    expect(harness.app.make<MediaManager>(MEDIA_TOKEN)).toBeInstanceOf(MediaManager);
  });

  it("binds the manager as a singleton", () => {
    expect(harness.app.make(MEDIA_TOKEN)).toBe(harness.app.make(MEDIA_TOKEN));
  });

  it("applies defaults when the app configures nothing", () => {
    expect(harness.media.config).toEqual({
      disk: null,
      path: null,
      pathNesting: 4,
      hashAlgorithm: "sha256",
      verifyHashes: false,
      accept: { mimes: [], extensions: [], maxBytes: null },
      imageDriver: null,
      connection: undefined,
    });
  });

  it("does not clobber config the app already set", async () => {
    const configured = await createHarness({
      disk: "public",
      path: "uploads",
      pathNesting: 2,
      hashing: { algorithm: "md5", verify: true },
      connection: "archive",
    });

    expect(configured.media.config).toMatchObject({
      disk: "public",
      path: "uploads",
      pathNesting: 2,
      hashAlgorithm: "md5",
      verifyHashes: true,
      connection: "archive",
    });

    await configured.cleanup();
  });

  it("ships the migration under a name matching its file", () => {
    expect(harness.provider.migrationSources()).toEqual([
      { name: "0001_create_media_table", migration: expect.anything() },
    ]);
  });

  it("registers the MediaFile model", () => {
    expect(harness.provider.models()).toEqual([MediaFile]);
  });

  it("registers no listeners", () => {
    // Asserted rather than assumed: the package has nothing to listen
    // to. It is the thing being observed, dispatching its own events
    // through the model's `dispatchesEvents`.
    expect(harness.provider.listeners).toBeUndefined();
  });

  it("cannot contribute routes or middleware at all", () => {
    // Stronger than a runtime assertion, and the compiler enforces it:
    // `routes()`/`middleware()` are declared by `@mahiframework/http`'s
    // provider-hooks module augmentation, and this package does not
    // depend on `http`. So the hooks are not merely unimplemented, they
    // are not in `ProviderHooks` for this build at all — referencing
    // either is a type error. Private media is served by the
    // application, over `serveStoredFile()` or a temporary URL.
    // @ts-expect-error -- `routes` is not a hook this package can have.
    expect(harness.provider.routes).toBeUndefined();
    // @ts-expect-error -- nor `middleware`.
    expect(harness.provider.middleware).toBeUndefined();
  });
});
