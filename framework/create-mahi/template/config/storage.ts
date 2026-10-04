import { storage_path } from "@mahiframework/core";
import type { StorageConfig } from "@mahiframework/storage";

/**
 * `default` is `local`, a PRIVATE disk under `storage/app/private`, served
 * to nobody unless a route deliberately streams a file from it (see
 * `serveStoredFile`). This matches Laravel: `Storage.put()` with no disk
 * argument must not land somewhere the whole internet can read.
 *
 * The `public` disk is the opposite: everything on it is reachable at its
 * `url` prefix. `AppServiceProvider.routes()` registers
 * `GET /storage/*` → `servePublicDisk("public")` so `Storage.disk("public")
 * .url(path)` actually resolves. Put a file there only when it's meant to
 * be downloadable without an auth check.
 *
 * `temporaryUrls: true` on the private disk enables
 * `Storage.temporaryUrl(path)`: a signed, expiring link to one file,
 * which is how you hand someone a private document without making the
 * disk public. It is served by the `GET /storage/temporary/*` route, also
 * registered in `AppServiceProvider.routes()`. The signature is the
 * credential, so the link works for anyone holding it until it expires —
 * which is the point, and the reason the default lifetime is short.
 */
export function storageConfig(): StorageConfig {
  return {
    default: "local",
    disks: {
      local: { root: storage_path("app/private"), temporaryUrls: true },
      public: { root: storage_path("app/public"), url: "/storage" },
    },
  };
}
