# Storage

`@mahiframework/storage` is a named-disk abstraction over file storage. One
interface, a core of six methods plus listing, streaming and metadata,
resolved by name through a `Manager`, the same pattern as
`DatabaseManager` and `CacheManager`.

```ts
import { Storage } from "@mahiframework/storage";

await Storage.put("avatars/427185966743560456.png", buffer);
const bytes = await Storage.get("avatars/427185966743560456.png");
const url = Storage.url("avatars/427185966743560456.png");   // "/storage/avatars/427185966743560456.png"
```

One driver ships: `local`, backed by the filesystem. A "public" disk is
not a special driver. It's a local disk that happens to have a `url`
prefix configured.

## The `StorageDriver` contract

```ts
interface StorageDriver {
  // Core
  put(path: string, contents: Buffer | string): Promise<void>;
  get(path: string): Promise<Buffer>;
  exists(path: string): Promise<boolean>;
  delete(path: string): Promise<void>;
  url(path: string): string;
  path(path: string): string;

  // Listing
  files(directory?: string): Promise<string[]>;
  allFiles(directory?: string): Promise<string[]>;
  directories(directory?: string): Promise<string[]>;
  allDirectories(directory?: string): Promise<string[]>;
  list(directory?: string): Promise<{ files: string[]; directories: string[] }>;

  // Streaming
  readStream(path: string, options?: { start?: number; end?: number }): Promise<Readable>;
  writeStream(path: string, options?: { flags?: "w" | "a" }): Promise<Writable>;
  putStream(path: string, source: Readable | ReadableStream | AsyncIterable<Uint8Array>): Promise<void>;

  // Metadata / manipulation
  size(path: string): Promise<number>;
  lastModified(path: string): Promise<Date>;
  mimeType(path: string): Promise<string | undefined>;
  copy(from: string, to: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  deleteDirectory(directory: string): Promise<void>;
  makeDirectory(directory: string): Promise<void>;

  // Links — filesystem and SFTP only; see Links below
  symlink(original: string, link: string): Promise<void>;
  hardlink(original: string, link: string): Promise<void>;
  supportsLink(kind: "soft" | "hard"): Promise<boolean>;
}
```

The **core** six (two of them synchronous string computations) cover the
motivating use case, "write a file, read it back, hand a client a URL
for it". The rest add directory listing, streaming and file metadata,
grouped so a driver author can see exactly what a new backend has to
implement.

A word of warning to anyone writing an `s3` (or other remote) driver:
every one of these is a thing you have to implement *correctly*, not
merely implement. `copy()` on S3 is a server-side copy API call; on the
filesystem it's a `copyFile`. `files(directory)` is cheap on a filesystem
and a paginated, eventually-consistent, potentially enormous listing via
`ListObjectsV2` on object storage. `readStream`/`putStream` map to
`GetObject`'s body and a multipart upload. `path()` has no answer on a
remote disk and throws there, and `temporaryUrl()` is a presigned link on
S3 but a signed route this application serves on everything else. The
interface is the same; the correctness bar per backend is not.

If you're on the `local` disk and want something the interface doesn't
expose, you still have the concrete driver as an escape hatch.
`Storage.disk("local")` returns a `LocalStorageDriver`, and `path()`
gives you a filesystem path you can hand to `node:fs` directly:

```ts
import { promises as fs } from "node:fs";

const { birthtime } = await fs.stat(Storage.path("uploads/report.pdf"));
```

The framework doesn't pretend every `node:fs` call is portable across
every backend, so it makes you write the non-portable thing explicitly.

## Configuration

`config/storage.ts`:

```ts
import { storage_path } from "@mahiframework/core";
import type { StorageConfig } from "@mahiframework/storage";

export function storageConfig(): StorageConfig {
  return {
    default: "public",
    disks: {
      local: { root: storage_path("app/private") },
      public: { root: storage_path("app/public"), url: "/storage" },
    },
  };
}
```

```ts
interface StorageConfig {
  default: string;
  disks: Record<string, DiskConfig>;
}

interface LocalDiskConfig {
  driver?: "local";
  root: string;
  url?: string;
}

type DiskConfig = LocalDiskConfig | { driver: string; [key: string]: unknown };
```

| Key | Meaning |
|---|---|
| `driver` | Optional for local disks. `"local"` is the default when omitted. |
| `root` | The directory every path on this disk resolves inside. Required. |
| `url` | The public HTTP prefix. Its presence is what makes a disk **public**. |

`url` may be a path (`"/storage"`) or a full origin
(`"https://cdn.example.com/media"`). Omit it entirely for a **private**
disk, one whose files are never addressable by a client directly.

`isLocalDiskConfig(value)` is the exported type guard the provider (and
`servePublicDisk`) uses to decide whether a config entry describes a
local disk:

```ts
function isLocalDiskConfig(value: unknown): value is LocalDiskConfig
```

It returns `true` when `value` is an object with a string `root` and a
`driver` that is either absent or exactly `"local"`. That check is why
`StorageServiceProvider` can register `LocalStorageDriver` factories for
every local disk while leaving disks belonging to a plugin driver alone.
The plugin's own `extend("s3", ...)` owns those.

## `LocalStorageDriver`

```ts
new LocalStorageDriver(root: string, urlPrefix?: string, options?: LocalStorageDriverOptions)
```

`options.temporaryUrl` supplies the builder behind `temporaryUrl()`. The
service provider passes it when the disk sets `temporaryUrls: true`; a
driver constructed by hand (as every test does) simply has no temporary
URLs, which keeps it usable with no container at all.

Every method funnels through one private `resolve()`:

```ts
private resolve(path: string): string {
  const rootResolved = pathModule.resolve(this.root);
  const full = pathModule.resolve(rootResolved, path);
  if (full !== rootResolved && !full.startsWith(rootResolved + pathModule.sep)) {
    throw new Error(`Path [${path}] escapes the storage root.`);
  }
  return full;
}
```

This is the path-traversal guard, and it is applied by **every** method:
`put`, `get`, `exists`, `delete`, `path`, **and `url()`**. `url()`
calling `resolve()` looks pointless (it throws away the result and builds
a URL from the prefix instead), but it isn't: a `url()` that skipped the
guard would happily emit `/storage/../../etc/passwd` for a caller who
passed `"../../etc/passwd"`, and whatever serves that prefix would then
have to re-validate. Validating once, in the driver, means every path
that ever leaves this class has been through the same check.

The comparison is on **resolved absolute** paths, not on string
inspection of the input, so `"../"`, `"foo/../../bar"`, absolute paths,
and encoded variants all collapse to the same normalized form before
being compared. The `full !== rootResolved` clause permits addressing the
root itself; the `startsWith(rootResolved + sep)` clause is what stops
`/var/storage-other` from passing a `/var/storage` root check.

`put()` creates intermediate directories (`mkdir` with `recursive: true`)
before writing. `delete()` uses `force: true`, so deleting a file that
isn't there is a no-op rather than an error. The contract has no
`missing()` and no "did it exist" return value, and it doesn't need one.

### `url()` throws on a private disk

```ts
url(path: string): string {
  if (this.urlPrefix === undefined || this.urlPrefix === "") {
    throw new Error(
      "This disk does not support retrieving URLs — it has no `url` prefix configured (it is a private disk). " +
        "Use `path()` for the on-disk filesystem location, or serve it through a route.",
    );
  }
  this.resolve(path);
  return joinPublicUrl(this.urlPrefix, path);
}
```

Calling `url()` on a disk with no `url` configured is an error, not a
fallback. This matches Laravel, whose `Storage::url()` raises *"This
driver does not support retrieving URLs"* for the same situation.

The alternative, returning the filesystem path, was tried and removed.
It is a Laravel-muscle-memory footgun of the worst kind: it doesn't
throw, it doesn't warn, and the failure mode is that
`/Users/deploy/app/storage/app/private/invoices/2026-01.pdf` gets
serialized into an API response and shipped to a client. That leaks your
absolute server paths and your directory layout, and it does it silently.

If you have a private disk and you want the filesystem location, ask for
it by name:

```ts
Storage.path("invoices/2026-01.pdf", "local");   // absolute on-disk path
Storage.url("invoices/2026-01.pdf", "local");    // throws
```

If you want a client to be able to fetch a private file, put a route in
front of it that does its own authorization and returns the bytes. See
[`serveStoredFile`](#servestoredfile) below.

## Listing files

Five methods list a disk. Every returned path is **disk-relative,
POSIX-separated (`/`) and sorted**, so a test can assert on them
deterministically. A directory argument is optional, omit it to list
from the disk root.

```ts
await Storage.files();              // files directly under the root
await Storage.files("avatars");     // files directly under avatars/
await Storage.allFiles("avatars");  // …recursively
await Storage.directories();        // immediate subdirectories
await Storage.allDirectories();     // …recursively
await Storage.list("avatars");      // { files, directories } — one level
```

```ts
const { files, directories } = await Storage.list("uploads");
// files:       ["uploads/a.png", "uploads/b.png"]
// directories: ["uploads/thumbs"]
```

**A directory that doesn't exist lists as empty**. `files("nope")`
returns `[]`, not an error, matching Laravel. A path-traversal argument
(`files("../..")`) still throws, like every other method.

## Streaming

Buffering a large file through `get()`/`put()` costs its whole size in
heap. The stream methods never do, a multi-gigabyte upload or download
flows through in chunks.

### `readStream(path, { start?, end? })`

A Node `Readable` over the file's bytes. Existence is checked up front, so
a missing file rejects with a typed `FileNotFoundException` **before** any
chunk. You never have to attach an error handler just to learn the file
wasn't there. `start`/`end` are inclusive byte offsets (as
`fs.createReadStream`), for serving a byte range.

```ts
import { FileNotFoundException } from "@mahiframework/storage";

const stream = await Storage.readStream("videos/clip.mp4");
stream.pipe(somewhere);

const slice = await Storage.readStream("big.bin", { start: 0, end: 1023 }); // first 1 KiB
```

### `writeStream(path, { flags? })`

A Node `Writable` to the file, with parent directories created first. The
default `flags: "w"` truncates; `"a"` appends. A `"w"` write goes to a
temp sibling and is `rename`d into place on `finish`, so **a crashed or
aborted write never leaves a partial file at the final path** (the same
atomic-write guarantee the file cache store wants).

```ts
const out = await Storage.writeStream("exports/report.csv");
out.write("a,b,c\n");
out.end("1,2,3\n");
await new Promise((res, rej) => out.on("finish", res).on("error", rej));
```

### `putStream(path, source)`

Drain any `Readable`, web `ReadableStream`, or `AsyncIterable<Uint8Array>`
onto the disk, Laravel's `put($path, $resource)`. Atomic, like
`writeStream`.

```ts
// From a fetch/Response body:
await Storage.putStream("cache/remote.json", (await fetch(url)).body!);
// From a request body in a handler:
await Storage.putStream(`uploads/${name}`, request.raw.body!);
```

## File metadata & manipulation

```ts
await Storage.size("a.pdf");          // number of bytes  (throws if missing)
await Storage.lastModified("a.pdf");  // Date             (throws if missing)
await Storage.mimeType("a.png");      // "image/png" | undefined (guessed from extension)
await Storage.copy("a.pdf", "backup/a.pdf");
await Storage.move("a.pdf", "archive/a.pdf");
await Storage.makeDirectory("thumbs");
await Storage.deleteDirectory("thumbs");   // recursive; no error if absent
```

`size()`/`lastModified()`/`copy()`/`move()` throw `FileNotFoundException`
when the (source) file is missing. `mimeType()` is a best-effort guess
from the extension, the disk has no real content-type concept, and
returns `undefined` for an unknown extension.

## Links

Two names for the same bytes, where the backend has such a notion.

```ts
await Storage.symlink("originals/photo.jpg", "albums/summer/photo.jpg");
await Storage.hardlink("originals/photo.jpg", "albums/summer/photo.jpg");

if (await Storage.supportsLink("hard")) { /* ... */ }
```

Only two of the four drivers can do this at all:

| Driver | `symlink()` | `hardlink()` |
|---|---|---|
| `local` | yes | yes |
| `sftp` | yes | only with `hardlink@openssh.com` (OpenSSH has it) |
| `s3` | no — object storage has no links | no |
| `ftp` | no — no link command in the protocol | no |

A driver that can't throws `UnsupportedDriverFeatureException`, which
carries `driver` and `feature` as fields so a caller can branch on it
without matching a message. It does **not** fall back to `copy()`: a copy
has independent bytes, an independent lifetime and double the storage
cost, so silently substituting one would break whichever of those
properties you wanted a link for, and do it invisibly. Call
`supportsLink(kind)` to ask first. It's async because the honest answer
isn't always local — SFTP hard links depend on what the *server*
advertises.

Shared rules, enforced by the contract suite against every driver:

- **Both paths are disk-relative and guarded.** Links are intra-disk; a
  target outside the root is refused. That isn't arbitrary — the local
  driver's symlink guard would then refuse to read the file back, so an
  escaping link is one the disk can create and can't use.
- **`original` must exist**, else `FileNotFoundException`, as with
  `copy()`/`move()`. Directories are rejected.
- **Parent directories of `link` are created**, as `copy()`/`move()` do.
- **An existing `link` path is an error, not a silent replace.** `move()`
  is the method that overwrites.
- **A link lists as a file.** `files()` reports one that resolves to a
  file, since `exists()`, `get()` and `size()` all see through it. A
  symlink to a *directory* is not reported by `directories()`, because
  `allDirectories()` descends what it lists and a link pointing at its own
  ancestor would make that walk unbounded.

The two kinds differ in what you'd expect. A symlink is a path reference:
it dangles if the original is deleted, and `exists()` then reports false.
A hard link is a second directory entry for the same inode, so there is no
"real one" and the bytes live until the last name is removed — but it
can't span filesystems, so on a disk root that straddles a mount point it
can fail where a symlink succeeds.

`LocalStorageDriver` writes symlink targets **relative to the link's own
directory**, so the storage root can be moved, re-mounted, or bind-mounted
at a different path inside a container without every link breaking. The
SFTP driver uses absolute remote targets, where there's no equivalent
"root moves" case to protect against.

## `StorageManager`

```ts
class StorageManager extends Manager<StorageDriver>
```

| Method | Returns | Notes |
|---|---|---|
| `disk(name?)` | `StorageDriver` | Alias for `driver()`. Default disk when `name` is omitted. |
| `url(path, disk?)` | `string` | `disk(disk).url(path)`. Throws for a private disk. |
| `path(path, disk?)` | `string` | `disk(disk).path(path)`. |
| `diskConfig<T>(name)` | `T` | The raw `disks[name]` config entry. |
| `getDefaultDriver()` | `string` | `config.default`. |
| `extend(name, factory)` | `this` | Register a driver. Inherited from `Manager`. |

`url()` and `path()` take the disk name as their **second** argument, so
the first argument always matches the driver method it forwards to.

Resolution is synchronous and cached per name, like every other
`Manager`. Constructing a `LocalStorageDriver` does no I/O at all, the
`mkdir`/`writeFile` happen lazily inside `put()`. `StorageServiceProvider`
therefore has no `boot()`.

```ts
export class StorageServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(STORAGE_TOKEN, (app) => {
      const config = app.config.get<StorageConfig>("storage");
      const manager = new StorageManager(app, config);

      for (const [name, disk] of Object.entries(config.disks)) {
        if (!isLocalDiskConfig(disk)) continue;
        manager.extend(name, () => new LocalStorageDriver(disk.root, disk.url));
      }

      return manager;
    });
  }
}
```

Note what this does: it registers **one factory per configured local
disk**, keyed by the disk's own name. Disk names *are* driver names in
this manager. There is no `createLocalDriver()` indirection layer
mapping a `driver` string onto a method. That's the same choice every
`Manager` in the framework makes.

Resolve it directly where you have the app:

```ts
import { app } from "@mahiframework/core";
import { StorageManager, STORAGE_TOKEN } from "@mahiframework/storage";

const storage = app().make<StorageManager>(STORAGE_TOKEN);
await storage.disk().put(path, image.buffer);
```

## The `Storage` facade

```ts
class Storage extends Facade<StorageManager>(() => STORAGE_TOKEN)
```

| Forwarded to the **default disk** | Forwarded to the **manager** |
|---|---|
| `put`, `get`, `exists`, `delete` | `disk`, `url`, `path` |

```ts
await Storage.put("avatars/1.png", buffer);          // default disk
await Storage.disk("local").put("backup.db", bytes); // a specific disk
Storage.url("avatars/1.png");                        // default disk
Storage.url("invoices/x.pdf", "local");              // named disk — throws (private)
```

There is no `Storage.put(..., disk)` overload. For a non-default disk, go
through `Storage.disk(name)`, which hands back a plain `StorageDriver`
with the identical methods.

Prefer injecting `StorageManager` via `STORAGE_TOKEN` where you already
have `app`, inside a `ServiceProvider`, a `Command`, a controller that
received it. The facade is for call sites where threading it through is
genuinely inconvenient. Same guidance as `app()` itself, and the same
test caveat: the facade resolves off the *current global* app, so a test
that builds its own isolated `Application` should resolve `STORAGE_TOKEN`
off that instance.

## Public URL helpers

Three exported functions handle the prefix arithmetic. They're pure
string functions with no dependency on the container, which is what lets
`servePublicDisk` live in this package without pulling in `@mahiframework/http`.

### `joinPublicUrl(prefix, path)`

```ts
joinPublicUrl("/storage", "avatars/1.png")
// "/storage/avatars/1.png"

joinPublicUrl("https://cdn.example.com/media/", "/posts/a.webp")
// "https://cdn.example.com/media/posts/a.webp"
```

Strips trailing slashes from the prefix, normalizes backslashes to
forward slashes in the path, strips leading slashes from the path, joins
with one `/`. This is what `LocalStorageDriver.url()` calls.

### `publicUrlPathname(prefix)`

The **path portion** of a prefix, what an incoming request path has to
start with for that prefix to match.

```ts
publicUrlPathname("/storage")                          // "/storage"
publicUrlPathname("storage")                           // "/storage"
publicUrlPathname("http://localhost:8000/storage")     // "/storage"
publicUrlPathname("https://cdn.example.com")           // "/"
```

An absolute-URL prefix contributes only its pathname. That's the point:
a disk configured with `url: "https://cdn.example.com/media"` is served
by your app at `/media` in development and by the CDN in production,
without a second config key for "the local path".

### `pathFromPublicUrl(requestPath, prefix)`

The inverse. Strips the prefix off an incoming request path and returns
the disk-relative path, or `null` when the request isn't under that
prefix or names no file.

```ts
pathFromPublicUrl("/storage/avatars/1.png", "/storage")   // "avatars/1.png"
pathFromPublicUrl("/storage", "/storage")                 // null  — the prefix itself
pathFromPublicUrl("/storage/", "/storage")                // null
pathFromPublicUrl("/other/x.png", "/storage")             // null  — not under the prefix
pathFromPublicUrl("/storage/a%20b.png", "/storage")       // "a b.png"
```

It `decodeURIComponent`s the result and returns `null` if that throws (a
malformed percent-escape) or yields an empty string. A `null` return is
the caller's cue to 404. Which is exactly what `servePublicDisk` does
with it.

## Serving files

### `serveStoredFile`

```ts
serveStoredFile(
  driver: StorageDriver,
  path: string,
  options?: {
    cacheControl?: string;
    contentType?: string;
    request?: { headers?: Headers; signal?: AbortSignal };
  },
): Promise<Response>
```

Streams `path` off `driver` and returns a web-standard `Response`. It
takes a `StorageDriver`, not a disk name, so it works with any disk you've
already resolved, including a private one behind your own authorization
check. The body is a streamed `Readable`, so a large file is never
buffered into memory.

Pass `options.request` (the incoming request's `headers` and abort
`signal`) to get **resumable, cache-aware** downloads:

- `Content-Length`, `Last-Modified`, a weak `ETag` (size+mtime) and
  `Accept-Ranges: bytes` are always set.
- A `Range: bytes=…` request returns **206** with `Content-Range` (and a
  **416** for an unsatisfiable range). Suffix (`bytes=-500`) and
  open-ended (`bytes=500-`) forms are supported; multipart ranges are not.
- `If-None-Match` / `If-Modified-Since` return a bodyless **304** when the
  client's copy is still fresh.
- When the client aborts (`signal`), the underlying read stream is
  destroyed instead of being drained to nowhere.

Omit `options.request` and you get a plain 200 with the whole body
(still streamed, still with the validators set).

```ts
import { Auth } from "@mahiframework/auth";
import { Controller, HttpResponse, type Request } from "@mahiframework/http";
import { Storage, serveStoredFile } from "@mahiframework/storage";

export class DownloadInvoiceController extends Controller {
  async handle(request: Request) {
    const invoice = await request.model(Invoice);
    if (invoice.user_id !== Auth.id()) {
      return HttpResponse.json({ message: "Forbidden" }, 403);
    }

    return serveStoredFile(Storage.disk("local"), invoice.path, {
      contentType: "application/pdf",
    });
  }
}
```

**A missing file and a path-traversal attempt both produce the same plain
404.** The traversal case throws out of `driver.exists()`; the handler
catches it and returns the identical response:

```ts
let exists: boolean;
try {
  exists = await driver.exists(path);
} catch {
  return new Response("Not Found", { status: 404 });
}
if (!exists) {
  return new Response("Not Found", { status: 404 });
}
```

That symmetry is the security property. If traversal produced a 400 with
`"Path [...] escapes the storage root."` and a missing file produced a
404, an attacker would have a working oracle: probe a path, read the
status, and learn whether their traversal reached a real directory. Same
status, same body, no leak. The error is still thrown by the driver. It
just never becomes a response.

`Content-Type` comes from `options.contentType` when given, otherwise
from a small extension→MIME table covering `jpg`/`jpeg`/`png`/`gif`/
`webp`/`svg`/`json`/`txt`/`pdf`. Anything else is
`application/octet-stream`. The disk itself has no content-type concept,
`get()` returns a bare `Buffer`, so this map is a property of the
*serving* helper, not of storage. `Content-Length` is set from the file's
size; `Cache-Control` is set only when you pass `cacheControl`.

The body is streamed, not buffered, a large download costs no heap. For
gigabytes of media in production you may still want a CDN in front of the
prefix (see below), but the process no longer OOMs on a big file.

### `servePublicDisk`

```ts
servePublicDisk(
  diskName: string,
  options?: ServeStoredFileOptions,
): (request: { path(): string }) => Promise<Response>
```

A route handler that serves a whole public disk under its configured
`url` prefix. Wire it with a **catch-all** route whose path matches that
prefix:

```ts
// src/routes/media.routes.ts
import type { Router } from "@mahiframework/http";
import { servePublicDisk } from "@mahiframework/storage";

export function registerMediaRoutes(router: Router): void {
  router.get(
    "/storage/*",
    servePublicDisk("public", { cacheControl: "public, max-age=31536000, immutable" }),
  );
}
```

```ts
// src/providers/media.provider.ts
export class MediaServiceProvider extends ServiceProvider {
  routes(router: Router): void {
    registerMediaRoutes(router);
  }
}
```

The `/storage/*` wildcard must line up with the disk's `url: "/storage"`.
The handler resolves the disk's config at request time, derives the
prefix pathname, and strips it, so if you change `url` you change the
route pattern to match, and nothing else.

Two failure modes, deliberately different:

- **The disk has no `url` configured**, `servePublicDisk` *throws*:
  `Disk [name] has no url configured — cannot serve it publicly.` This is
  a wiring bug in your app, not a client error, and surfacing it as a 500
  in development is the point.
- **The request path isn't under the prefix, or names no file**.
  `pathFromPublicUrl` returns `null` and the handler 404s.

The handler's parameter type is structural, `{ path(): string }`, not
`@mahiframework/http`'s `Request`. That's what keeps `@mahiframework/storage` free of a
dependency on the HTTP package while still being usable directly as a
route handler.

### There is no `storage:link`

Laravel ships `php artisan storage:link` because PHP web servers serve
files out of a fixed document root, and `storage/app/public` is not in
it. The symlink exists purely to drag those files into a directory the
web server will look at.

Node has no document root. Your application process *is* the server, and
a route is all it takes to serve any path on disk. `servePublicDisk` is
that route. There is no symlink, no artisan command, and no
"did you remember to run storage:link" deployment step.

The trade-off is that every public file is served by your Node process,
which is fine for avatars and post images and wrong for gigabytes of
video. When it stops being fine, point the disk's `url` at a CDN origin
that reads from the same bucket, `url()` starts emitting CDN URLs, the
catch-all route stops being hit, and no application code changes.

## Temporary URLs for private files

`url()` throws on a private disk, because there is no public address for
the file. `temporaryUrl()` is the answer when you need to hand someone
*one* file for a *short* time — an invoice, an export, a receipt — without
making the disk public or writing a bespoke authorised route.

```ts
const url = await Storage.temporaryUrl("invoices/2026-01.pdf");        // default disk, 5 minutes
const url = await Storage.temporaryUrl("exports/q1.csv", 900, "local"); // 15 minutes, named disk
const url = await Storage.disk("local").temporaryUrl("receipt.pdf");    // straight off the driver
```

Two strategies, one result. A backend that signs links natively does
that: an S3 disk returns a presigned URL and the bytes never touch your
application. Every other disk returns a signed link to a route your
application serves, which verifies the signature and streams the file.
Either way you get an absolute, expiring URL, and calling code does not
have to know which kind of disk produced it.

### Wiring the fallback

Two things, both in the scaffold already:

```ts
// config/storage.ts — opt the disk in.
local: { root: storage_path("app/private"), temporaryUrls: true },
```

```ts
// AppServiceProvider.routes() — mount the route, BEFORE any /storage/* catch-all.
router.get("/storage/temporary/*", serveTemporaryDiskFile()).name("storage.temporary");
```

The opt-in is per disk and deliberate. The signature is already the
authorisation, so this is defence in depth: the config is the list of
disks reachable over HTTP at all, which bounds what a leaked `APP_KEY`
could reach. A disk without it throws from `temporaryUrl()` rather than
handing back a link that would 404.

Links are absolute, so they need an origin: the active request's, or
`http.url` (`APP_URL`) when there isn't one — a queue job emailing a link
has no request, which is exactly when a relative URL would silently be
wrong.

### What the signature covers

The HMAC covers the **disk name, the file path and the expiry together**.
A link cannot be edited to read a different file, to read the same path
on a different disk, or to last longer. It is signed with `APP_KEY`,
HKDF-narrowed to the `"url"` purpose, so it shares no key with session
cookies.

The handler verifies the signature itself rather than relying on
`validateSignature()` middleware. Forgetting to attach middleware should
not turn the route into an unauthenticated read of every disk; attaching
it as well is harmless.

Range requests work, so a video or a large PDF is seekable through a
temporary URL.

### What it is not

**It is not an authorisation check.** Anyone holding the link can read
the file until it expires — the same model as a presigned S3 URL, or the
email-verification links the framework already mints. Keep lifetimes
short, and when a download must be tied to *who* is asking, write a route
that checks the user and calls `serveStoredFile` instead.

**The fallback proxies the bytes.** A local disk is reading from the same
machine, so that is free. An SFTP or FTP disk pulls the file over the
wire and pushes it to the client, and on FTP every download serialises
behind other operations on that connection.

## S3: files in object storage

`@mahiframework/storage-s3` is a driver for S3 and anything speaking its
protocol: AWS, Cloudflare R2, DigitalOcean Spaces, MinIO, Supabase,
Backblaze. It is where uploads belong once an application runs on more
than one machine, since a local disk is per-container state and a second
replica can't read what the first one wrote.

It is a separate package so an application that never uses S3 doesn't
install the AWS SDK, which is 18 MB and 27 packages.

```bash
npm install @mahiframework/storage-s3 @aws-sdk/client-s3 @aws-sdk/lib-storage
```

The SDK packages are **optional peer dependencies**, imported on first
use. A disk that is configured but never touched costs nothing — not the
sockets, and not the SDK being parsed. If one is missing, the driver says
so with the command that fixes it rather than failing with a
module-not-found from deep inside a write.

```ts
// config/storage.ts
import { env } from "@mahiframework/core";

export function storageConfig(): StorageConfig {
  return {
    default: "uploads",
    disks: {
      uploads: {
        driver: "s3",
        bucket: env("S3_BUCKET", "app-uploads"),
        region: env("AWS_REGION", "us-east-1"),
      },
      // A self-hosted or non-AWS endpoint.
      media: {
        driver: "s3",
        bucket: "media",
        endpoint: env("S3_ENDPOINT"),
        credentials: {
          accessKeyId: env("S3_KEY"),
          secretAccessKey: env("S3_SECRET"),
        },
        url: env("CDN_URL"),
      },
    },
  };
}
```

```ts
// config/app.ts — after StorageServiceProvider, which binds STORAGE_TOKEN.
providers: [StorageServiceProvider, S3StorageServiceProvider];
```

Note that `credentials` is **optional**, and omitting it is usually
right. Left out, the SDK's own chain applies: environment variables,
shared config, SSO, IMDS on EC2, the projected token on EKS. Hardcoding
keys into `config/storage.ts` is the wrong default anywhere with an
instance role.

| Key | Meaning |
|---|---|
| `driver` | `"s3"`. Required, it's what makes the provider claim the disk. |
| `bucket` | The bucket. Required. |
| `region` | Defaults to `us-east-1`. Meaningless to most compatible servers, but the SDK won't sign without one. |
| `endpoint` | Omit for AWS. Set it for R2, Spaces, MinIO, and anything self-hosted. |
| `forcePathStyle` | Bucket in the path rather than the hostname. Defaults to `true` when `endpoint` is set. |
| `credentials` | Omitted, the SDK's credential chain applies. |
| `root` | Key prefix, so one bucket can back several disks. |
| `partSize` | Multipart part size in bytes. Default and minimum 5 MiB. |
| `queueSize` | Parts uploaded concurrently within one object. Default 4. |
| `pageSize` | Keys per listing request. Default and maximum 1000. |
| `url` | Public prefix — a CDN, or the bucket's public endpoint. |

### What it costs that a local disk doesn't

The interface is identical. The storage model is not, and the driver
documents rather than hides the differences:

**Writes are atomic for free.** A multipart upload is invisible until it
completes, so an aborted write leaves nothing at the key and no dangling
upload. The local and SFTP drivers write to a temp sibling and rename to
fake exactly this guarantee; here the protocol already provides it, so
`writeStream`'s `finish` means the object is readable at its final key.

**Directories don't exist.** `makeDirectory()` writes a zero-byte marker
at `prefix/`, which is what makes an empty directory visible to
`directories()`. Listings filter those markers out, so one never surfaces
as a file. A directory implied only by a nested key is reported too, so
`allDirectories()` is the same answer a filesystem would give.

**`allFiles()` is paginated.** One request returns at most 1000 keys, so
a large prefix is many sequential round trips into one array. It works,
and it is not cheap; on a bucket with a million objects, prefer narrowing
the directory over listing the root.

**`copy()` is server-side and `move()` is not atomic.** `CopyObject`
means the bytes never reach this process, so copying a 40 GB object costs
no bandwidth — the opposite of the SFTP driver. There is no rename, so
`move()` is a copy followed by a delete.

**Appending rewrites the object.** S3 objects are immutable, so
`writeStream(path, { flags: "a" })` downloads the existing bytes and
re-uploads them with the new ones appended. Fine for a small file,
expensive for a large one, and unavoidable.

**`url()` throws** unless you configured a `url` prefix. Whether a bucket
is publicly readable depends on its policy, which the driver can't read,
so nothing is guessed. **`path()` always throws** — the bytes aren't on
this machine.

**`symlink()`/`hardlink()` always throw.** A bucket maps keys to bytes and
has no notion of one key referring to another. `copy()` is server-side and
cheap, but it is a duplicate rather than a link, so the driver refuses
instead of silently substituting it. See [Links](#links).

### Signed URLs for private objects

A private bucket has no public URL, but it can have a time-limited one,
and on S3 that is a **presigned** link the bucket itself validates — the
bytes go straight from S3 to the client without passing through your
application:

```ts
const url = await Storage.temporaryUrl("invoices/2026-01.pdf", 300, "uploads");
```

This needs `@aws-sdk/s3-request-presigner`, the third optional peer
dependency, and is the only thing that does.

`temporaryUrl()` is on `StorageDriver`, so the same call works on every
disk — see [Temporary URLs](#temporary-urls-for-private-files) for how
the non-S3 disks honour it. If you would rather the bucket stayed
unreachable from the internet entirely, set `temporaryUrls: "proxy"` on
the disk and downloads are routed through your application instead, at
the cost of the bytes making the extra hop.

### A disk per database row

The same pattern as SFTP below, and for the same reason: buckets that
live in **rows** rather than in config need a disk built on demand.

```ts
storage.extend(`tenant:${tenant.id}`, () => new S3StorageDriver({
  bucket: tenant.bucket,
  region: tenant.region,
}));
```

`extend()` invalidates any driver cached under that name, and
`forget(name)` drops the factory and releases the client's pooled
sockets.

## SFTP: files on another machine

`@mahiframework/storage-sftp` is a second driver, for files that live on
a host you reach over SSH: a NAS, a seedbox, a media server that isn't
mounted locally. It is a separate package so an application that never
uses SFTP doesn't install an SSH stack.

```bash
npm install @mahiframework/storage-sftp ssh2
```

`ssh2` is an **optional peer dependency**. The driver imports it on first
use and, if it's missing, says so with the command that fixes it rather
than failing with a module-not-found from somewhere deep inside a write.

```ts
// config/storage.ts
import { env } from "@mahiframework/core";

export function storageConfig(): StorageConfig {
  return {
    default: "public",
    disks: {
      public: { root: storage_path("app/public"), url: "/storage" },
      media: {
        driver: "sftp",
        host: env("MEDIA_HOST", "nas.local"),
        port: 22,
        username: env("MEDIA_USER", "media"),
        password: env("MEDIA_PASSWORD"),
        root: "/srv/media",
      },
    },
  };
}
```

```ts
// config/app.ts — after StorageServiceProvider, which binds STORAGE_TOKEN.
providers: [StorageServiceProvider, SftpStorageServiceProvider];
```

From there it is a disk like any other, and code that takes a
`StorageDriver` doesn't know the difference:

```ts
await Storage.disk("media").allFiles("movies");
const stream = await Storage.disk("media").readStream("movies/clip.mkv");
```

| Key | Meaning |
|---|---|
| `driver` | `"sftp"`. Required, it's what makes the provider claim the disk. |
| `host` / `port` | The SSH server. `port` defaults to 22. |
| `username` | The login user. Required. |
| `password` | Password auth. |
| `privateKey` / `passphrase` | Key auth. The key **contents**, not a path. |
| `root` | The disk root. Relative paths resolve against the login user's home. |
| `concurrency` | Max in-flight requests during a recursive walk. Default 8. |
| `keepaliveInterval` | SSH keepalive in ms. Default 20000; `0` disables. |
| `readyTimeout` | Handshake timeout in ms. Default 20000. |
| `hostVerifier` | Verify the host key. Omitted, **any** host key is accepted. |
| `url` | Public prefix, only if something *else* serves these files over HTTP. |

### What it costs that a local disk doesn't

The interface is identical. The performance characteristics are not, and
the driver documents rather than hides the differences:

**`copy()` is a download and a re-upload.** SFTP has no server-side copy
primitive, so copying a 40 GB file moves 80 GB across the wire. It's
streamed, so it costs no memory, but it is not the cheap metadata
operation `copyFile` is locally. `move()` *is* a server-side rename, and
is cheap at any size.

**`url()` throws** unless you configured a `url` prefix. SFTP serves no
HTTP, so there is no URL to derive. A prefix only makes sense when a
separate web server publishes the same directory. To hand a client a
file with no such server, put a route in front of it with
`serveStoredFile`, which streams and supports range requests.

**`path()` always throws.** The bytes are on another machine. Returning a
remote path that `node:fs` would then fail to open is worse than
refusing.

**`temporaryUrl()` needs the fallback route.** SFTP has no presigning of
its own, so set `temporaryUrls: true` on the disk and mount
`serveTemporaryDiskFile()`. The file is then pulled over SSH and streamed
to the client by your application. See
[Temporary URLs](#temporary-urls-for-private-files).

**`symlink()` always works; `hardlink()` needs OpenSSH.** Symlinks are
core SFTP. Hard links are the `hardlink@openssh.com` extension, which
OpenSSH offers and other servers may not — against one that doesn't,
`hardlink()` throws `UnsupportedDriverFeatureException` and
`supportsLink("hard")` reports `false` once something has probed for it.
The probe only happens at the point of use, since ssh2 surfaces a missing
extension no earlier. See [Links](#links).

**Recursive listing is bounded.** `allFiles()` is one `readdir` per
directory, and they share a single SSH channel, so `concurrency` caps
in-flight requests rather than adding throughput. Everything is still
sorted, and a missing directory is still `[]`.

**Path traversal is checked lexically only.** The local driver
additionally `realpath`s every target, because a symlink inside its root
can point outside it. Over SFTP the server resolves symlinks and enforces
its own permissions. The honest way to confine a remote account is on the
server (a chrooted SFTP user), not with a client-side check the client
can't back up. The lexical guard still rejects the `../` that matters in
application code.

### Atomic writes, honestly

`writeStream`/`putStream` write to a temp sibling and rename into place,
so a crashed write never leaves a partial file at the final path. Over
SFTP that last step has a caveat worth knowing: plain SFTP `rename`
**fails if the target exists**, so an atomic replace needs OpenSSH's
`posix-rename@openssh.com` extension.

Where the server offers it (OpenSSH does, so nearly every real
deployment) the replace is genuinely atomic. Where it doesn't, the driver
falls back to unlink-then-rename, which has a brief window in which the
path doesn't exist. That's a real downgrade, so it's reported rather than
hidden:

```ts
const disk = Storage.disk("media") as SftpStorageDriver;
disk.sftp().replacesAtomically();  // true | false | undefined (not yet probed)
```

### Connections

One SSH session per driver instance, reused across every operation. This
isn't an optimisation so much as the difference between a usable driver
and an unusable one: a handshake is several round trips, and `allFiles()`
is one request per directory.

A long-lived connection dies in ways a fresh one can't, though: a NAS
spins down, a NAT table forgets the flow, an appliance hits its own idle
timeout. So a connection-level failure is retried **once** on a fresh
session, and only a second failure surfaces. Retrying is safe because a
transport failure means the server never processed the request. A server
error (no such file, permission denied) is never retried. Once, not
"until it works", because infinite retry against a host that's genuinely
gone is indistinguishable from a hang.

Registering a disk doesn't connect, and neither does resolving one. The
session opens on the first actual operation, so a NAS asleep at boot is
not a boot failure. `SftpStorageServiceProvider.shutdown()` closes
whatever was opened.

### A disk per database row

Config-file disks are registered at boot. Applications that store remote
hosts as **rows** (one per library, say) need a disk built on demand:

```ts
function diskFor(library: Library): StorageDriver {
  const name = `library:${library.id}`;

  if (!storage.isResolved(name)) {
    storage.extend(name, () => new SftpStorageDriver({
      host: library.host,
      username: library.username,
      privateKey: library.private_key,
      root: library.path,
    }));
  }

  return storage.disk(name);
}
```

`extend()` invalidates any driver already cached under that name, so
re-extending after a row is edited is all it takes for the next
resolution to use the new host.

When a row is **deleted**, drop the disk with `forget()`:

```ts
await storage.forget(`library:${library.id}`);
```

`forget(name)` disconnects the resolved driver and unregisters the
factory. Without it the only thing that ever calls `disconnect()` is
`disconnectAll()` at shutdown, so a dropped disk would leak its SSH
session for the life of the process.

## FTP: files on a legacy or appliance host

`@mahiframework/storage-ftp` is for hosts that speak nothing else: NAS
boxes, cheap shared hosting, appliances. FTP and SFTP share four letters
and nothing else — different protocols, different ports, different
libraries — so the SFTP driver cannot talk to an FTP server and this is a
separate package rather than an option on that one.

```bash
npm install @mahiframework/storage-ftp basic-ftp
```

`basic-ftp` is an **optional peer dependency**, imported on first use. It
has no dependencies of its own.

```ts
// config/storage.ts
import { env } from "@mahiframework/core";

export function storageConfig(): StorageConfig {
  return {
    default: "public",
    disks: {
      public: { root: storage_path("app/public"), url: "/storage" },
      archive: {
        driver: "ftp",
        host: env("ARCHIVE_HOST", "nas.local"),
        user: env("ARCHIVE_USER", "archive"),
        password: env("ARCHIVE_PASSWORD"),
        secure: true,
        root: "/backups",
      },
    },
  };
}
```

```ts
// config/app.ts — after StorageServiceProvider, which binds STORAGE_TOKEN.
providers: [StorageServiceProvider, FtpStorageServiceProvider];
```

| Key | Meaning |
|---|---|
| `driver` | `"ftp"`. Required, it's what makes the provider claim the disk. |
| `host` / `port` | The FTP server. `port` defaults to 21. |
| `user` | The login user. Required. Note: `user`, not `username` — that's the SFTP driver's key. |
| `password` | The login password. |
| `secure` | `true` for FTPS over explicit TLS, `"implicit"` for the legacy variant. **Omitted means cleartext.** |
| `secureOptions` | TLS options, as in `tls.connect(options)`. |
| `root` | The disk root. Relative paths resolve against the login directory. |
| `timeout` | Per-command timeout in ms. Default 30000. |
| `verbose` | Log the FTP conversation to stderr. For debugging a server's dialect. |
| `url` | Public prefix, only if something *else* serves these files over HTTP. |

### Use FTPS

Plain FTP is **cleartext** — credentials and file contents both. Set
`secure: true` wherever the server supports it. The driver doesn't refuse
plain FTP, because LAN appliances and legacy hosts are the reason it
exists, but that is a deliberate concession and not a default worth
keeping over the internet.

### What it costs, which is more than the other drivers

FTP is the weakest backend of the three on every axis. All of it is
protocol-level limitation rather than anything the driver can fix, and the
driver surfaces the limits rather than papering over them:

**Everything is serialised.** FTP's control connection carries one command
at a time, and the client errors rather than corrupting the session if you
try two. So there is no `concurrency` to tune and a recursive
`allFiles()` is strictly sequential round trips — where the SFTP driver
runs a bounded worker pool, this cannot.

**`readStream({ end })` transfers the bytes it discards.** FTP's `REST`
gives a start offset and the protocol has no end offset, so the limit is
enforced client-side: the stream ends and the data connection closes once
the range is satisfied, but the server has already begun sending the rest.
This matters because `serveStoredFile()` issues exactly this call for an
HTTP `Range` request.

**`lastModified()` is a round trip per file.** Without `MLSD` a `LIST`
response carries a human-formatted date with no year and no timezone,
which `basic-ftp` refuses to parse rather than guess at, so the time comes
from `MDTM` per file. `disk.ftp().supportsMlsd()` reports which case you
are in.

**`copy()` goes via local disk.** FTP has no server-side copy, and the
download and upload cannot overlap on one connection, so the bytes land in
a temp file in between. Memory stays flat; disk doesn't. `move()` is a
server-side rename and is cheap at any size.

**Atomic replace depends on the server.** Writes go to a temp sibling and
rename into place, but the FTP spec doesn't require `RNFR`/`RNTO` to
clobber an existing target. Where the server refuses, the driver falls back
to delete-then-rename, which has a brief window where the path doesn't
exist. That downgrade is reported rather than hidden:

```ts
const disk = Storage.disk("archive") as FtpStorageDriver;
disk.ftp().replacesAtomically();  // true | false | undefined (not yet attempted)
```

**`url()` throws** without a configured prefix, and **`path()` always
throws** — the bytes are on another machine.

**`symlink()`/`hardlink()` always throw.** FTP has no link command. Some
servers expose one via `SITE SYMLINK`, but `SITE` has no portable syntax
and no way to discover support short of trying it and reading prose out of
a 500 reply — a driver that worked on one appliance and failed on the next
would be worse than one that is clear it can't. Use an `sftp` disk if the
host also speaks SSH. See [Links](#links).

**`temporaryUrl()` needs the fallback route**, as with SFTP: set
`temporaryUrls: true` and mount `serveTemporaryDiskFile()`. Note the
download is proxied through your application *and* serialised behind
every other operation on the connection, so handing out several links at
once means several queued transfers. See
[Temporary URLs](#temporary-urls-for-private-files).

## Writing a custom driver

Implement the `StorageDriver` methods and register a factory with
`extend()`. S3, SFTP and FTP are already covered by their own packages;
what follows is the shape for a backend that isn't — Azure Blob, GCS,
WebDAV — using a hypothetical blob service. Only the core six are shown
for brevity.

The three shipped drivers are also worth reading as worked examples,
since each one meets the contract differently: `storage-s3` gets write
atomicity from the protocol, `storage-sftp` builds it from a
temp-and-rename, and `storage-ftp` serialises everything because its
client allows one command at a time.

```ts
import { ServiceProvider } from "@mahiframework/core";
import { StorageManager, STORAGE_TOKEN, joinPublicUrl, type StorageDriver } from "@mahiframework/storage";

export class BlobStorageDriver implements StorageDriver {
  constructor(
    private config: { container: string; url?: string },
    // The fallback builder, when the application wired one. A driver
    // can't build it itself: the link addresses a *disk name*, which only
    // the provider knows.
    private temporaryUrlBuilder?: TemporaryUrlBuilder,
  ) {}

  async put(path: string, contents: Buffer | string): Promise<void> { /* ... */ }
  async get(path: string): Promise<Buffer> { /* ... */ }
  async exists(path: string): Promise<boolean> { /* ... */ }
  async delete(path: string): Promise<void> { /* ... */ }
  // …plus files/allFiles/directories/allDirectories/list,
  //    readStream/writeStream/putStream,
  //    size/lastModified/mimeType/copy/move/makeDirectory/deleteDirectory.

  url(path: string): string {
    if (!this.config.url) {
      throw new Error("This disk does not support retrieving URLs.");
    }
    return joinPublicUrl(this.config.url, path);
  }

  path(): string {
    throw new Error("The blob driver has no on-disk path.");
  }

  // A backend without links refuses, naming what to use instead. Don't
  // quietly copy: different bytes, different lifetime, double the cost.
  async symlink(original: string, link: string): Promise<void> {
    throw new UnsupportedDriverFeatureException("blob", "symbolic links", "Use copy().");
  }
  async hardlink(original: string, link: string): Promise<void> {
    throw new UnsupportedDriverFeatureException("blob", "hard links", "Use copy().");
  }
  async supportsLink(kind: "soft" | "hard"): Promise<boolean> {
    return false;
  }

  // If the backend presigns, do that. Otherwise delegate to the fallback,
  // and throw when there isn't one — a link that 404s is worse.
  async temporaryUrl(path: string, expiresIn = 300): Promise<string> {
    if (!this.temporaryUrlBuilder) {
      throw new Error("This disk cannot make temporary URLs — set `temporaryUrls: true`.");
    }
    return this.temporaryUrlBuilder(path, expiresIn);
  }
}

export class BlobServiceProvider extends ServiceProvider {
  boot(): void {
    const storage = this.app.make<StorageManager>(STORAGE_TOKEN);
    storage.extend("media", () =>
      new BlobStorageDriver(storage.diskConfig("media")),
    );
  }
}
```

Three things to get right:

**Register in `boot()`, not `register()`**, if you're extending a manager
another provider owns. `STORAGE_TOKEN` has to be bound first. (Or
register in your own `register()` and accept the ordering constraint in
`config/app.ts`; `RedisServiceProvider` does exactly that for cache,
queue and broadcasting.)

**Name the factory after the disk, not the driver.** `extend("media",
...)` registers the disk called `media`. `StorageServiceProvider` skips
any disk whose config isn't `isLocalDiskConfig()`, precisely so a
non-local disk name is left free for your `extend()` to claim.

**`path()` should throw for a remote driver.** It is documented as "only
meaningful for filesystem-backed disks". A driver that returns a
plausible-looking-but-fake path is worse than one that refuses.

**Refuse links you can't make, and make `supportsLink()` agree.** Throw
`UnsupportedDriverFeatureException` rather than falling back to `copy()`,
and don't report support you don't have — the contract suite checks both
directions, so a `supportsLink()` that lies is a test failure.

If your driver needs async warm-up, implement `Connectable`
(`connect()`/`disconnect()`) and call `connect()` from your provider's
`boot()`. `Manager.driver()` is always synchronous and will never await
for you. See [Providers](../providers/).

## Testing

There is no storage fake, and there doesn't need to be one: point a disk
at a temp directory.

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageDriver } from "@mahiframework/storage";

const root = mkdtempSync(join(tmpdir(), "mahi-storage-"));
const disk = new LocalStorageDriver(root, "/storage");

await disk.put("a/b.txt", "hello");
expect(await disk.exists("a/b.txt")).toBe(true);
expect((await disk.get("a/b.txt")).toString()).toBe("hello");
expect(disk.url("a/b.txt")).toBe("/storage/a/b.txt");

rmSync(root, { recursive: true, force: true });
```

`LocalStorageDriver` has no container dependency at all, so it's
constructible standalone. For a full-application test, set
`storage.disks.*.root` to a temp directory in the test's config.

### The driver contract suite

`StorageDriver` is 25 methods, and most of them carry a guarantee the
signature doesn't show: listings are sorted, a missing directory is `[]`
rather than an error, `readStream` rejects *before* the first chunk, a
truncating stream write is atomic. A driver can satisfy every type and
miss every one of those.

So the contract ships as executable cases, and every driver runs the same
ones. If you write a driver, run them against it:

```ts
import { storageDriverContract } from "@mahiframework/storage";

describe("MyStorageDriver", () => {
  for (const testCase of storageDriverContract()) {
    it(testCase.name, async () => {
      await testCase.run(await freshDriver());  // an EMPTY disk per case
    });
  }
});
```

Each case gets an empty disk and may leave anything behind; isolation is
the caller's job. Failures throw plain `Error`s rather than calling a
matcher, which is what keeps `@mahiframework/storage` free of a
test-runner dependency.

```ts
storageDriverContract({
  urlPrefix: "/storage",  // assert url() returns prefix + path; omitted, assert it THROWS
  hasPath: false,         // the bytes aren't local, so assert path() throws
  hasTemporaryUrl: true,  // this disk can sign one; omitted, assert temporaryUrl() REJECTS
  largeFileBytes: 512 * 1024,  // default 8 MiB; lower it when each chunk costs a round trip
  hasSymlink: true,       // assert links work and are guarded; omitted, assert they THROW
  hasHardlink: true,      // separate flag, because SFTP has one kind and not the other
});
```

Every driver runs it — local, S3, SFTP and FTP — which is what stops a
local and a remote disk from quietly becoming two different abstractions
behind one interface.

## Gotchas

**`url()` throws on a private disk.** It does not fall back to a
filesystem path. Use `path()` for that, or serve the file through a route.

**Path traversal throws, it doesn't return `false`.** `exists("../x")`
raises rather than reporting "no". Anything calling `exists()` on
untrusted input needs a `try`/`catch`. `serveStoredFile` has one.

**`delete()` is silent on a missing file.** `force: true`. There is no
return value telling you whether anything was removed.

**The default disk in a generated app is `public`.** `Storage.put(...)`
with no disk writes somewhere world-readable via `/storage/*`. Private
uploads go to `Storage.disk("local")` explicitly.

**`servePublicDisk`'s route pattern and the disk's `url` must agree.**
Nothing validates that they do. A `url: "/files"` disk behind a
`/storage/*` route 404s every request, because `pathFromPublicUrl`
returns `null` for a path that isn't under `/files`.

**`serveStoredFile` needs `options.request` for ranges and conditional
GETs.** It always streams and sets `ETag`/`Last-Modified`, but without the
request's headers it can't honour `Range` or `If-None-Match`, pass
`{ request: { headers, signal } }` to get 206/304 and client-abort
handling.

**A non-existent directory lists as `[]`.** `files("nope")` returns an
empty array, not an error, but a *traversal* argument (`files("../..")`)
still throws, like every other method.

**Read/metadata methods throw `FileNotFoundException` on a missing
file.** `get`, `readStream`, `size`, `lastModified`, and the source of
`copy`/`move` reject with the typed exception (importable from
`@mahiframework/storage`), distinct from the plain `Error` a traversal raises.

**`finish` on a `writeStream` means the file is readable.** The rename
happens before the event, not in a listener beside it, so
`await` the stream and then reading the path back is safe rather than a
race.

**`writeStream`/`putStream` are atomic for `"w"`, not `"a"`.** A truncating
write goes through a temp file + `rename`, so a crash leaves no partial
file; an append (`flags: "a"`) writes in place and has no such guarantee.

**`get()` returns a `Buffer`, never a string.** Call `.toString()`
yourself, with whatever encoding is actually right.

**Disk names are driver names.** `extend("public", ...)` replaces the
public disk's factory entirely. There's no separate driver-type layer to
override instead.

**On SFTP, `path()` and (unconfigured) `url()` throw, and `copy()` is
expensive.** The bytes are on another machine: there's no local path, no
HTTP URL, and no server-side copy primitive. See
[SFTP](#sftp-files-on-another-machine).

**Links only exist on `local` and `sftp`.** S3 and FTP throw
`UnsupportedDriverFeatureException`, and they do not fall back to a copy.
Ask `supportsLink(kind)` first if the disk is configurable. See
[Links](#links).

**Links can't leave the disk.** Both arguments are disk-relative and
guarded, so you can't link to a path outside the storage root — the local
driver's own symlink guard would refuse to read it back anyway.

**Linking onto an existing path throws.** Unlike `put()`, which
overwrites, neither link method will replace what's already there. Delete
it first, or use `move()`.

## Related

- [Configuration](../configuration/): `config/storage.ts`, `storage_path()`
- [Providers](../providers/): registering a custom driver via `extend()`, boot ordering
- [Routing](../routing/): mounting the catch-all that `servePublicDisk` handles
- [Requests](../requests/): reading uploaded files out of a multipart body
- [Responses](../responses/): what else you can return from a route handler
- [Container](../container/): `STORAGE_TOKEN`
- [Mail](../mail/): attaching a stored file to a message
