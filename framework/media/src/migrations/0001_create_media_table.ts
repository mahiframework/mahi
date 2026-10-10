import { Schema, type Migration, type Blueprint } from "@mahiframework/database";

/**
 * One table for every kind of file: avatars, logos, documents, uploads.
 *
 * `id` is an auto-increment `bigIncrements` primary key, assigned by the
 * database.
 *
 * `model_type`/`model_id` are BOTH NULLABLE, which is unusual for a morph
 * pair and is the `belongsToMedia` case. There the foreign key lives on
 * the OWNER's table (`users.avatar_id`), so the media row records no
 * owner at all — the reference points the other way. A `hasManyMedia`
 * row fills both. The consequence worth knowing: a row reached only
 * through such a foreign key cannot be found by owner, so `media:prune`
 * can only reclaim it once the app has declared the column with
 * `registerMediaReference()`. Undeclared, the row and its bytes outlive
 * the owner permanently — the file sweep cannot help, since the row
 * still exists and its path is therefore still known.
 *
 * `model_id` is TEXT, not a typed key column, and this is the one place
 * the schema diverges from `permissions`. That table's `model_id` is the
 * local side of a `morphToMany` pivot, and `buildPivotQuery()` binds the
 * local key value RAW — a `bigint` against a `varchar` makes Postgres
 * raise `operator does not exist` — so it has no choice but to match the
 * key's type exactly, which costs it one key type per application.
 * Nothing here does that. This column is only ever read back by equality
 * through `morphMany` eager loading, which stringifies both sides, so
 * text holds every key type losslessly and ANY model can own media
 * regardless of how it keys — including two models in one app that key
 * differently. A multipurpose media package has no business restricting
 * that. Same column and same reasoning as `notifications.notifiable_id`.
 *
 * NO FOREIGN KEYS. A polymorphic `model_type`/`model_id` pair cannot
 * have one, and the app-owned table on the other side of a
 * `belongsToMedia` key is not this package's to name. Same reasoning as
 * `activity_logs.model_id` and `sessions.user_id`.
 *
 * `path` has no unique index. Two rows legitimately point at one file
 * after a `replicate()`, and the generated path is a UUID, so collision
 * is not the risk a unique index would be guarding against. Deleting one
 * of those rows deleting a file the other still references is a real
 * hazard, and the honest fix is reference counting rather than a
 * constraint that would reject the second insert outright.
 *
 * `disk` is nullable, meaning "the storage default, resolved at read
 * time". `Storage.disk(undefined)` already resolves that way, so a row
 * written before a `storage.default` change keeps working. Narrow at 64
 * characters: it holds a config key, not a path.
 *
 * `extension` is NOT NULL but may be the empty string. A file with no
 * discernible type is a real thing (laravel-media's own fixtures have
 * one), and `""` says "none" in a way a nullable column would make every
 * reader branch on.
 *
 * `custom_properties` is `json` rather than `text`, unlike
 * `activity_logs.data`. That column is written cheaply and never queried
 * inside; this one holds alt text and captions that an admin screen
 * genuinely does filter on, so the engine's own JSON support is worth
 * having. `JsonCast` serialises to a string either way, so an app that
 * wants `jsonb` can alter the column without breaking anything.
 *
 * `image_width`/`image_height` are nullable because most files are not
 * images. For files that ARE, they are populated on every upload rather
 * than only when a modifier runs — laravel-media leaves them null on a
 * plain upload, which makes them useless for the layout-shift problem
 * they exist to solve.
 *
 * Both timestamps, unlike `activity_logs`. A media row is mutable: its
 * `order` changes on every reorder, and its custom properties change
 * whenever someone edits an alt text.
 */
const migration: Migration = {
  async up(): Promise<void> {
    await Schema.create("media", (table: Blueprint) => {
      table.bigIncrements("id");

      // Written by hand rather than `nullableMorphs("model")`, which
      // would make `model_id` an `unsignedBigInteger`. See the header.
      table.string("model_type").nullable();
      table.string("model_id").nullable();

      table.string("collection").nullable();

      table.string("disk", 64).nullable();
      table.string("path");
      table.string("original_filename");
      table.unsignedBigInteger("size");
      table.string("mime_type");
      table.string("extension");

      table.string("checksum_hash");
      table.string("checksum_algo", 16);

      table.unsignedInteger("image_width").nullable();
      table.unsignedInteger("image_height").nullable();

      table.unsignedInteger("order").default(0);
      table.json("custom_properties").nullable();

      table.timestamp("created_at");
      table.timestamp("updated_at");

      // "Everything this record owns", the query the table exists to
      // serve. The equality pair leads so `order` can serve the ORDER BY
      // from the same index.
      table.index(["model_type", "model_id", "order"]);
      // "This collection across every owner", for an admin listing.
      table.index(["collection"]);
      // "Every PDF", "every image" — a prefix match on a sniffed type.
      table.index(["mime_type"]);
      // Newest-first listings, and the cutoff `media:prune` scans by.
      table.index(["created_at"]);
    });
  },

  async down(): Promise<void> {
    await Schema.drop("media");
  },
};

export default migration;
