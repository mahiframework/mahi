# Media

`@mahiframework/media` is one table for every file an application stores:
avatars, logos, invoice PDFs, video, arbitrary uploads. A row records
where the file is, what it is, and who owns it.

```ts
import { MediaFile } from "@mahiframework/media";

const files = await MediaFile.for(user.morphAlias(), user.id).get();

files.first()?.url();        // "/storage/8c19165c/9b72/4d57/90ae/21d7….webp"
files.first()?.size;         // 182_344
```

Ownership is polymorphic, so one table serves every model: a `User`'s
avatar, a `Post`'s gallery and a `Tenant`'s logo are all rows in `media`,
discriminated by `model_type`.

> **Work in progress.** This page documents what the package ships
> today: the model, the table and the configuration. Uploading,
> attaching media to a model, and image modifiers land in later releases.

Not installed by default:

```bash
npm install @mahiframework/media
```

...then list the provider in `config/app.ts` **after**
`DatabaseServiceProvider` (the package owns a table and a model),
**after** `StorageServiceProvider` (every file is written through a
disk), and **after** `SnowflakeServiceProvider`:

```ts
import { MediaServiceProvider } from "@mahiframework/media";

export const providers: ServiceProviderClass[] = [
  // ...
  DatabaseServiceProvider,
  StorageServiceProvider,
  SnowflakeServiceProvider,
  MediaServiceProvider,
];
```

`SnowflakeServiceProvider` is a **hard runtime requirement**, not merely
a compile-time one. `MediaFile` keys on a snowflake, which is generated
by resolving `SNOWFLAKE_TOKEN`, so an app that omits the provider gets
`BindingNotFoundError` on its first upload rather than at boot — late,
and a long way from the cause.

Then run the migration:

```bash
./artisan migrate
```

## The table

| Column | Type | |
|---|---|---|
| `id` | `bigint` | A snowflake. |
| `model_type`, `model_id` | `string?` | The owning record. Both null when the owner holds the key instead. |
| `collection` | `string?` | A bucket within one owner: `"photos"`, `"attachments"`. |
| `disk` | `string?` | Null means "the storage default, resolved at read time". |
| `path` | `string` | Disk-relative, with extension. Never user-supplied. |
| `original_filename` | `string` | The name the file arrived with. |
| `size` | `number` | Bytes, as stored. |
| `mime_type` | `string` | Sniffed from the file, not from the client. |
| `extension` | `string` | No leading dot. May be `""`. |
| `checksum_hash`, `checksum_algo` | `string` | Defaults to sha256. |
| `image_width`, `image_height` | `number?` | Images only. |
| `order` | `number` | Position within a collection. |
| `custom_properties` | `json?` | Alt text, captions, anything. |

Three of those are worth expanding on.

**`model_id` is text.** It holds the key of *any* model, and two models
in one application can key differently — a snowflake `User`, a UUID
`Tenant`. Only text holds both, so any model can own media regardless of
how it keys. (`@mahiframework/permissions` makes the same column a
`bigint` and restricts role-holders to snowflake-keyed models; it has no
choice, because its column is a pivot key bound raw into SQL. Nothing
here does that.)

**Both morph columns are nullable.** A file referenced by a foreign key
on the owner's own table — `users.avatar_id` — records no owner, because
the reference points the other way.

**`path` is generated, never derived from the upload.** It is a UUID
split across four directories:

```
8c19165c/9b72/4d57/90ae/21d7b362a9f3.webp
```

Keeping a user-supplied filename off the filesystem is what stops
`../../etc/passwd` from ever being a question, and it means two people
uploading `photo.jpg` do not collide. The original name is kept in
`original_filename` and used for downloads.

## URLs

A media row knows which disk it lives on, and
[storage](../storage/) already knows whether that disk is public:

```ts
media.isPublic();            // does this disk have a `url` prefix?
media.url();                 // throws on a private disk
await media.temporaryUrl();  // a signed, expiring link
```

`url()` throwing on a private disk is storage's contract, not this
package's — the message tells you to configure a `url` prefix or use a
temporary URL. `isPublic()` is the predicate for branching beforehand.

**This package ships no download route.** Private media is served by the
application, either through `temporaryUrl()` or through its own route
over `serveStoredFile()`, which already handles ranges, `ETag`s,
conditional requests and client aborts. A route shipped from here would
have to either skip authorization entirely or invent a policy hook for a
decision the application is better placed to make.

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
    // Verify the stored file on every read. Off by default: it costs a
    // full read, which makes streaming pointless.
    verify: false,
  },

  // An application-wide floor on what may be uploaded.
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
    return (this.custom_properties?.alt as string) ?? "";
  }
}

useMediaModels({ media: AppMediaFile });
```

Call it from a provider's `register()`. See
[extending package models](../extending-models/) for adding columns.
