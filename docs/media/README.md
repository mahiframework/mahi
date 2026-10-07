# Media

`@mahiframework/media` is one table for every file an application
stores: avatars, logos, invoice PDFs, video, arbitrary uploads. A row
records where the file is, what it is, and who owns it.

Files are attached through fluent builders declared on the owning model:

```ts
class User extends Model<UserAttributes>()({ table: "users", morphName: "User" }) {
  avatar() {
    return belongsToMedia(this, "avatar_id")
      .accept({ mimes: ["image/*"], maxBytes: 5_000_000 })
      .withModifiers([cropToSquare(), resizeDown(512, 512), format("webp")]);
  }

  photos() {
    return hasManyMedia(this).collection("photos").keepLatest(20);
  }
}
```

```ts
await user.avatar().set(request.file("avatar"));
await user.photos().add(request.files("photos"));
await user.photos().sync([existingId, newFile, otherId]);

const photos = await user.photos().get();
photos.first()?.url();
```

Not installed by default:

```bash
npm install @mahiframework/media
```

...then list the provider in `config/app.ts` **after**
`DatabaseServiceProvider` (the package owns a table and a model) and
**after** `StorageServiceProvider` (every file is written through a
disk):

```ts
import { MediaServiceProvider } from "@mahiframework/media";

export const providers: ServiceProviderClass[] = [
  // ...
  DatabaseServiceProvider,
  StorageServiceProvider,
  MediaServiceProvider,
];
```

Then run the migration:

```bash
./artisan migrate
```

## The three relations

| | Link | `add` semantics |
|---|---|---|
| `hasManyMedia(this)` | `media.model_type`/`model_id` | appends, ordered |
| `hasOneMedia(this)` | `media.model_type`/`model_id` | `set()` replaces |
| `belongsToMedia(this, "avatar_id")` | a key on the **owner's** table | `set()` replaces |

Declare them as **methods**, not fields:

```ts
photos() { return hasManyMedia(this).collection("photos"); }
```

A field would run its initialiser before the ORM has assigned the row's
attributes, and would depend on `useDefineForClassFields` — under
assignment semantics it hits the model proxy's `set` trap, becomes a
dirty-tracked attribute, and makes the next `save()` try to write a
`photos` column. A method avoids both and reads the same at the call
site.

`belongsToMedia` needs a column on the owner's table, which is your
migration to write:

```ts
table.bigInteger("avatar_id").nullable();
```

Choose it when you want a real foreign key. Choose `hasOneMedia` when
you would rather not add a column.

### Configuration

Every method returns a **new** builder, so a per-call override is local
to that call:

```ts
await user.photos().accept({ extensions: ["jpg"] }).add(file);  // this call only
```

| | |
|---|---|
| `collection(name)` | Tags writes **and** scopes reads |
| `disk(name)` | Write to a named disk |
| `rootPath(prefix)` | A path prefix under the disk root |
| `filename(name)` | Override the stored download name |
| `accept({ mimes, extensions, maxBytes })` | Narrows what may be uploaded |
| `keepLatest(n)` | Evict the oldest beyond `n` (`hasManyMedia` only) |
| `withModifiers([...])` | Transform images before storing |
| `withCustomProperties({...})` | Stamp metadata on every file added |

`accept()` **narrows** the app-wide `media.accept` floor and cannot widen
it: an app that caps uploads at 5MB has made a decision about its disk
and its bandwidth.

### `sync()`

One ordered array mixing ids of rows to keep with new files to upload:

```ts
await user.photos().sync([existingId, newFile, otherExistingId]);
```

New files take the slot they occupied, surviving rows are renumbered in
payload order, and anything absent from the payload is deleted — rows
and files. The whole thing is a transaction, and file deletions are
deferred until after it commits, so a failure part-way through leaves
both the rows and the bytes as they were.

`syncFromRequest(request, key)` merges `request.input(key)` with
`request.files(key)` by position, which is what lets one HTML form
submit "keep #5, here is a new file, keep #2".

## Uploads

Anything file-shaped works: a web `File` from `request.file()`, a
`Buffer`, a local path, a Node or web stream, or
`{ stream, filename }`.

```ts
await Media.add(request.file("logo"), { collection: "logos" });
await Media.add(buffer, { owner: { type: "User", id: user.id } });
```

The `Media` facade is the model-less path — a seeder, a queue job
holding only `{ type, id }`, an import script. Prefer the builders for
anything owned by a model, since they carry the collection, the disk and
the accept rules from one declaration.

Large sources are streamed to a temporary file rather than buffered, so a
5GB upload works on a small container. Nothing is left behind: see
[temporary files](../helpers/#temporary-files).

### Order of operations

Validate, then write the file, then insert the row. A rejected upload
touches neither, and a failed write leaves no row pointing at missing
bytes. The opposite failure — a file with no row — is possible and
recoverable: `media:prune --files` reclaims it.

### The client's `Content-Type` is not evidence

It is a header the uploader controls. Every decision this package makes
— whether the file is accepted, what extension it is stored under,
whether an image driver sees it — follows from the file's own leading
bytes.

```ts
// Uploaded as "report.pdf", actually a PNG.
const media = await Media.add(file);

media.mime_type;  // "image/png"
media.extension;  // "png"
```

A file whose bytes begin `<?php`, `#!`, `<script` or `<html` is refused
**unconditionally**, whatever the accept rules say and whatever it is
named. Such a file sniffs as no known format, so a MIME-only check would
admit it on its extension's word — and on a public disk served by
anything that executes PHP, that is remote code execution.

### Paths

The storage path is a random UUID split across four directories, never
anything derived from the upload:

```
8c19165c/9b72/4d57/90ae/21d7b362a9f3.webp
```

Keeping a user-supplied name off the filesystem is what stops
`../../etc/passwd`, a 300-character name, and a `.php` extension from
ever being a question. Nesting keeps any one directory small. The
original name lives in `original_filename` and is used for downloads.

## Image modifiers

```ts
withModifiers([
  cropToSquare(),
  resizeDown(512, 512),
  format("webp"),
  quality(82),
]);
```

| | |
|---|---|
| `resizeDown(w?, h?)` | Fit inside the bounds, preserving ratio. **Never enlarges** |
| `cropToSquare()` | A **centred** square crop |
| `format(target)` | Encode as another format. Takes `"webp"` or `"image/webp"` |
| `quality(1–100)` | Lossy quality. Clamped, not rejected |
| `setBackgroundColor(color)` | Flatten transparency onto a solid colour |
| `rotate(degrees)` | Rotate clockwise |

Modifiers run **before** the file is written, so `size`, `mime_type`,
`extension`, the dimensions and the checksum all describe the bytes that
actually landed on the disk — and a `format()` change produces a path
with the right extension rather than a `.png` file claiming to be WebP.

They are skipped entirely for anything that is not a raster image. A PDF
or a video with a modifier chain attached is stored unchanged, so a
multipurpose collection needs no branching. SVG counts as "not an
image": it is an image to a browser and a text document to a decoder.

### Image drivers

**This package ships no image library.** Modifiers describe *intent* as
data, and a driver executes it — the same `gd`-versus-`imagick` split
Laravel has. An app that stores only documents therefore pays for no
native build at all.

`@mahiframework/media-sharp` is the driver:

```bash
npm install @mahiframework/media-sharp sharp
```

```ts
// config/app.ts
import { MediaSharpServiceProvider } from "@mahiframework/media-sharp";

export const providers: ServiceProviderClass[] = [
  // ...
  MediaServiceProvider,
  MediaSharpServiceProvider,  // either order works, see below
];
```

```ts
// config/media.ts
export default {
  image: { default: "sharp" },

  sharp: {
    // A decompression-bomb bound. Worth lowering for public uploads.
    limitInputPixels: 50_000_000,
  },
};
```

`sharp` is an **optional peer dependency** — 19 MB and 25
platform-specific packages — loaded by `import()` on first use. So three
layers of "not installed" give three different, correct messages: no
driver configured raises `NoImageDriverError`, a configured driver with
no `sharp` names the install command, and an operation the driver cannot
do raises `UnsupportedImageOpError`.

Unlike the storage drivers, `MediaSharpServiceProvider` may be listed
**before or after** `MediaServiceProvider`. It registers in `boot()`,
and every provider's `register()` runs before any `boot()`, so
`IMAGE_TOKEN` is bound either way.

See the [package reference](#the-sharp-driver) below for what it
does and does not do.

Writing your own driver means implementing six methods (`read`,
`create`, `apply`, `encode`, `dimensions`, `supports`) and registering
it:

```ts
images.extend("sharp", () => new SharpImageDriver());
```

A driver that cannot perform an operation reports `supports()` false and
**throws** rather than silently skipping, so a missing crop is an error
rather than an unmodified image.

Two testing aids ship for this:

```ts
// Record operations without decoding anything.
const driver = new FakeImageDriver(1000, 800);
driver.assertSequence(["crop", "scaleDown"]);

// Hold a real driver to the same contract.
for (const testCase of imageDriverContract(() => new MyDriver(), { image, width, height })) {
  it(testCase.name, () => testCase.run());
}
```

### The sharp driver

Every generic modifier works, and the driver adds a few things libvips
does well that the portable ops cannot express.

| `sharp` config | Default | |
|---|---|---|
| `limitInputPixels` | 268 megapixels | Decompression-bomb bound. **Lower it for public uploads** |
| `autoOrient` | `true` | Apply the EXIF orientation tag on read |
| `allowAnimated` | `false` | Accept an animated image and flatten it to frame one |

**EXIF orientation is applied on read.** A phone photo is stored in
sensor orientation with a tag saying how to turn it, so ignoring the tag
produces sideways thumbnails — and corrupts geometry, because
`cropToSquare()` measures the image to decide its crop.

**`limitInputPixels` is the only guard against a decompression bomb.** A
60-megapixel PNG is a few hundred kilobytes compressed and 240 MB
decoded; `accept.maxBytes` cannot catch it, because the file is small.

**Animated images are refused rather than flattened.** A modifier chain
on an animated GIF or WebP raises `AnimatedImageError` (wrapped by
`media` as `UndecodableImageError`), because this driver transforms one
frame at a time and silently returning a still is data loss the uploader
would never be told about. Store it without modifiers to keep the
animation, branch on `isAnimated(bytes)` beforehand, or set
`allowAnimated: true` to accept the flattening deliberately.

**PNG stays lossless.** `quality()` on a PNG opts into palette
quantisation — the in-process equivalent of `pngquant` — and without it
the output is byte-for-byte lossless. JPEG gets `mozjpeg` and a default
of 82, WebP 80, and AVIF 55, because AVIF's scale is not JPEG's.

#### Driver-specific modifiers

```ts
import { sharpModifier, blur, grayscale, sharpen, trim } from "@mahiframework/media-sharp";

withModifiers([
  resizeDown(1200),
  sharpen(),
  sharpModifier("vignette", (pipeline) => pipeline.modulate({ brightness: 0.9 })),
]);
```

Shipped: `blur`, `sharpen`, `grayscale`, `tint`, `trim` (auto-crop
uniform borders) and `extend` (pad to a size). `sharpModifier(name, fn)`
covers everything else.

**These are not portable.** A chain containing one only runs under this
driver and throws under any other — which is the honest trade, and why
the function is named `sharpModifier` rather than something neutral.
Inside `fn`, make at most **one** geometry call (`resize`, `extract`,
`rotate`): sharp's pipeline is lazy and a second one silently replaces
the first. Filters compose freely.

#### Cost

**A modifier chain costs one libvips pass per op**, not one for the
chain. An image handle holds raw pixels rather than a lazy sharp
pipeline, which is what makes `[resizeDown(80), cropToSquare()]` crop
against 80×48 instead of the source's 100×60 — two `.resize()` calls on
one sharp instance do not compose, and `metadata()` mid-pipeline reports
the *source* dimensions. Correctness was worth the passes.

In practice a chain of two or three modifiers on a web-sized upload is a
few hundred milliseconds. An app transforming thousands of images a
second should write sharp directly rather than through a portable
interface.

## URLs and downloads

A media row knows its disk, and [storage](../storage/) already knows
whether that disk is public:

```ts
media.isPublic();            // does this disk have a `url` prefix?
media.url();                 // throws on a private disk
await media.temporaryUrl();  // a signed, expiring link
```

`url()` throwing on a private disk is storage's contract, not this
package's — the message names the fix. `isPublic()` is the predicate for
branching beforehand.

**This package ships no download route.** Private media is served by the
application, through `temporaryUrl()` or its own route over
`serveStoredFile()`, which already handles ranges, `ETag`s, conditional
requests and client aborts. A route shipped from here would have to
either skip authorization entirely or invent a policy hook for a
decision the application is better placed to make.

### Archives

```ts
const zip = MediaZip.of(await user.photos().get()).filename("photos.zip");

return new Response(zip.webStream(), {
  headers: {
    "Content-Type": "application/zip",
    "Content-Disposition": contentDisposition("attachment", zip.name()),
  },
});
```

Streamed, not buffered: each file is read from its disk, deflated and
emitted in chunks, so a 50GB archive of a thousand files costs the same
memory as a 1MB one. Zip64 throughout, so neither 4GB files nor 65535
entries are a limit. Duplicate download names de-duplicate as
`photo-2.jpg`.

`nameEntries()` groups files into folders:

```ts
zip.nameEntries((media) => `${media.collection}/${media.original_filename}`);
```

## Reading

```ts
await media.contents();                        // the whole file
await media.readStream({ start: 0, end: 1023 }); // a byte range
await using temp = await media.toTempFile();   // a local copy for ffmpeg
```

`toTempFile()` exists because you cannot hand an S3 key to a tool that
expects `open(2)`.

### Custom properties

```ts
await media.setCustomProperty("alt", "A cat on a sofa").save();

media.getCustomProperty("alt");
media.hasCustomProperty("alt");
await media.forgetCustomProperty("alt").save();
```

Setters merge rather than replace, and do not save — so several can be
set and written once.

### Checksums

Every row records a `sha256` of its stored bytes.

```ts
await media.verify();  // throws MediaChecksumMismatchError
```

Verification is streamed, and opt-in: it reads every byte. On success,
a row hashed under an older algorithm than the one now configured is
transparently rehashed — which makes changing `hashing.algorithm` a
background migration rather than a flag day.

## Eager loading

The builders are the write side. For reads across many records, declare a
plain relation:

```ts
export interface PostAttributes {
  // ...
  media: MorphMany<MediaFile>;
}

export class Post extends Model<PostAttributes>()({ ... }) {
  static override relationships = {
    media: mediaRelation(),
  };
}

await Post.query().with("media").get();
```

A collection filter cannot live in the relation — filter at query time
with `with({ media: (q) => q.where("collection", "photos") })`, or use
`MediaFile.inCollection()`.

> **Push `static morphName` or `Relation.morphMap()`.** `morphAlias()`
> falls back to the *table name*, so renaming a table orphans every media
> row naming the old one — and media rows outlive table renames.
> `media:check` reports it when it happens.

## Events

```
MediaEvent (abstract)
  ├── MediaCreated
  ├── MediaUpdated
  └── MediaDeleted
```

One registration on the base class catches all three, and anything added
later:

```ts
events.listen(MediaEvent, AuditMediaListener);
```

`MediaCreated` fires after the file is on the disk, so a listener that
queues a virus scan or a transcode can rely on the bytes being there.

Deleting a row deletes its file, however the delete happens — the hook is
on the model, so a relation write, a cascade and a direct
`deleteInstance()` all clean up.

## Commands

```bash
./artisan media:prune --dry-run
./artisan media:prune --files
./artisan media:check --verify
```

`media:prune` deletes rows whose owner no longer exists, and under
`--files` sweeps bytes with no row. Nothing cascades into this table —
`media.model_id` carries no foreign key, because it holds the key of
*any* model and the app owns those tables — so this command is the other
half of that trade. It is **not** scheduled automatically: deleting a
user's uploads is not a decision a package should make on a timer, and
the file sweep lists an entire disk.

`media:check` verifies that every row's file is present, that every
`model_type` resolves to a registered model, and under `--verify` that
every checksum still matches. Exits non-zero, so CI or a monitor can gate
on it.

## The table

| Column | Type | |
|---|---|---|
| `id` | `bigint` | Auto-increment. |
| `model_type`, `model_id` | `string?` | The owning record. Both null for `belongsToMedia`. |
| `collection` | `string?` | A bucket within one owner. |
| `disk` | `string?` | Null means "the storage default, resolved at read time". |
| `path` | `string` | Disk-relative, with extension. Generated, never user-supplied. |
| `original_filename` | `string` | The name the file arrived with. |
| `size` | `number` | Bytes, as stored. |
| `mime_type` | `string` | Sniffed from the file, not from the client. |
| `extension` | `string` | No leading dot. May be `""`. |
| `checksum_hash`, `checksum_algo` | `string` | Defaults to sha256. |
| `image_width`, `image_height` | `number?` | Images only, on every upload. |
| `order` | `number` | Position within a collection. 1-indexed. |
| `custom_properties` | `json?` | Alt text, captions, anything. |

**`model_id` is text.** It holds the key of *any* model, and two models
in one application can key differently — an auto-increment `User`, a
UUID `Tenant`. Only text holds both.
(`@mahiframework/permissions` makes the same column a `bigint` and
restricts role-holders to integer-keyed models; it has no choice,
because its column is a pivot key bound raw into SQL. Nothing here does
that.)

**Both morph columns are nullable.** A file referenced by a foreign key
on the owner's own table records no owner, because the reference points
the other way.

## Configuration

Every key is optional. An app that never writes `config/media.ts` gets
files on the storage default disk, four-level paths and sha256 checksums.

```ts
// config/media.ts
export default {
  // The disk new files are written to. Omit for the storage default.
  disk: "public",

  // A path prefix under the disk root.
  path: "uploads",

  // Directory levels the generated UUID path is split across.
  pathNesting: 4,

  hashing: {
    algorithm: "sha256",
    verify: false,
  },

  // The image driver modifiers run through. No default, and no driver
  // ships with this package — install @mahiframework/media-sharp.
  image: { default: "sharp" },

  // Read by @mahiframework/media-sharp, if it is installed.
  sharp: {
    limitInputPixels: 50_000_000,
    autoOrient: true,
    allowAnimated: false,
  },

  // An application-wide floor that no relation can widen.
  accept: {
    mimes: ["image/*", "application/pdf"],
    extensions: ["jpg", "png", "webp", "pdf"],
    maxBytes: 10 * 1024 * 1024,
  },
};
```

There is deliberately **no list of public disks**. Packages in other
ecosystems carry one because their storage layer cannot answer "is this
disk publicly readable"; Mahi's can, and a second list here could only
ever disagree with the real one.

`accept.mimes` is matched with `Str.is`, so `"image/*"` works. Both lists
are compared case-insensitively, and satisfying *either* is enough.

## Using your own model

Subclass `MediaFile` to add methods, scopes or casts — Mahi's static
finders are this-polymorphic, so `AppMediaFile.find(id)` returns an
`AppMediaFile`. To make the **package's own** reads and writes produce
your class, register it:

```ts
import { MediaFile, useMediaModels } from "@mahiframework/media";

export class AppMediaFile extends MediaFile {
  get alt(): string {
    return this.getCustomProperty<string>("alt") ?? "";
  }
}

useMediaModels({ media: AppMediaFile });
```

Call it from a provider's `register()`. See
[extending package models](../extending-models/) for adding columns.

## Limits

- **No conversions.** One row per file. Thumbnails as separate records —
  laravel-media's `conversion_parent_id` — are not implemented, and
  adding them later is a migration.
- **No image processing without a driver package.** Install
  [`@mahiframework/media-sharp`](#the-sharp-driver).
- **Animation is not preserved** by the sharp driver. A modifier chain on
  an animated upload errors rather than flattening it.
- **No download routes.** The app serves private media itself.
- **No generators.** A PDF or video stores fine; nothing extracts a
  cover frame or a video still.
- **A builder is per-call.** `user.photos()` rebuilds its configuration
  each time; it is not a cached relation, and `with()` does not populate
  it. Use `mediaRelation()` for eager loading.

## Related

- [Storage](../storage/): disks, `temporaryUrl()`, `serveStoredFile()`
- [Models](../models/): the ORM the `MediaFile` model is built on
- [Helpers](../helpers/#temporary-files): `TempFile`, used for large uploads
- [Extending package models](../extending-models/): subclassing `MediaFile`
