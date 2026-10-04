import {
  app,
  buildSignedUrl,
  verifySignedPayload,
  SIGNER_TOKEN,
  type SignedRequestLike,
  type SignerLike,
} from "@mahiframework/core";

/**
 * Builds a time-limited URL for a path on one disk.
 *
 * A closure rather than a disk name on the driver, because a driver does
 * not know what it is called: `new LocalStorageDriver(root, url)` is
 * constructible with no container at all, and `StorageConfig.disks` is
 * private to the manager, so there is no reverse lookup from a driver
 * instance back to its disk name. The service provider is the one place
 * that holds both, so it captures the name and hands down a builder.
 *
 * That also makes Laravel's `buildTemporaryUrlsUsing()` fall out for
 * free: an application that wants its own scheme passes its own closure.
 */
export type TemporaryUrlBuilder = (path: string, expiresIn: number) => Promise<string>;

/**
 * Where the stock fallback route is mounted. The disk name and the file
 * path follow as path segments.
 */
export const TEMPORARY_URL_PREFIX = "/storage/temporary";

/**
 * The context key `@mahiframework/http`'s `Request` publishes the current
 * request's scheme+host under.
 *
 * Duplicated as a literal rather than imported: `@mahiframework/storage`
 * does not depend on `@mahiframework/http` (and http avoids depending on
 * storage, to the point of duplicating its MIME table). The value is part
 * of http's public API and is read the same way by `UrlGenerator.root()`.
 */
const REQUEST_ROOT_CONTEXT_KEY = "__mahi_request_root";

/**
 * The stock `TemporaryUrlBuilder`: a signed link at the fallback route.
 *
 * The signature covers the **disk name and the file path together**, so a
 * link minted for one disk cannot be edited to read another, and a link
 * for one file cannot be edited to read its neighbour. Expiry is carried
 * as a signed `expires` param, so it cannot be extended either.
 *
 * Absolute, like a presigned S3 URL, so the two strategies are
 * interchangeable — code that emails a link does not have to know which
 * kind of disk produced it. That means it needs an origin, which comes
 * from the active request, or `http.url` config, or an error. Returning a
 * relative path instead would silently change shape depending on whether
 * a request happened to be in flight, which is exactly the surprise a
 * queue job emailing a link should not hit in production only.
 */
export function signedDiskUrls(diskName: string): TemporaryUrlBuilder {
  return async (path: string, expiresIn: number): Promise<string> => {
    const signer = resolveSigner();
    const relative = `${TEMPORARY_URL_PREFIX}/${encodePathSegments(diskName)}/${encodePathSegments(path)}`;
    const signed = buildSignedUrl(relative, {}, signer, { expiresInSeconds: expiresIn });

    return `${origin()}${signed}`;
  };
}

/**
 * Whether a request to the fallback route carries a valid, unexpired
 * signature for the path it is asking for.
 *
 * Takes the structural `{ path(), queryString() }` rather than
 * `@mahiframework/http`'s `Request`, for the same reason
 * `servePublicDisk` takes a structural `{ path() }`.
 */
export function hasValidDiskSignature(request: SignedRequestLike): boolean {
  return verifySignedPayload(request, resolveSigner());
}

/**
 * The `Signer`, narrowed to the `"url"` purpose.
 *
 * Resolved by string token and typed structurally, so this package does
 * not depend on `@mahiframework/encryption` — whose `argon2` dependency
 * is a native build that an application using storage without hashing
 * should not pay for. `@mahiframework/broadcasting` resolves the same
 * signer the same way.
 *
 * The `"url"` narrowing is what keeps these signatures in a disjoint key
 * space from session cookies, and it must match the narrowing
 * `@mahiframework/http` applies, or links signed by one would not verify
 * in the other.
 */
function resolveSigner(): SignerLike {
  const container = app();

  if (!container.has(SIGNER_TOKEN)) {
    throw new Error(
      "Temporary URLs need a Signer, but SIGNER_TOKEN is not bound. Add " +
        "EncryptionServiceProvider to `config/app.ts` (it derives the signing key from APP_KEY).",
    );
  }

  return container.make<SignerLike>(SIGNER_TOKEN).for("url");
}

/** The scheme+host to prefix a signed path with. */
function origin(): string {
  const container = app();
  const fromRequest = container.context.get<string>(REQUEST_ROOT_CONTEXT_KEY);

  if (fromRequest) {
    return stripTrailingSlash(fromRequest);
  }

  const configured = container.config.get<string>("http.url");

  if (configured) {
    return stripTrailingSlash(configured);
  }

  throw new Error(
    "Cannot build a temporary URL: no active request and no `http.url` config set. " +
      "A temporary URL is absolute, like a presigned S3 one, so it needs an origin — " +
      "set `http.url` (APP_URL), which is also what queue jobs and scheduled tasks use.",
  );
}

/**
 * Percent-encode each segment, leaving the separators alone, so a file
 * name containing a space or a `#` survives the round trip. Mirrors
 * `joinPublicUrl`.
 */
function encodePathSegments(value: string): string {
  return value
    .split("/")
    .filter((segment) => segment !== "")
    .map(encodeURIComponent)
    .join("/");
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
