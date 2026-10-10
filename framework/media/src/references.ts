/**
 * A foreign key on an application-owned table that points at `media.id`.
 *
 * `belongsToMedia` puts the reference on the OWNER's table
 * (`users.avatar_id`), so the media row records no owner at all — both
 * morph columns stay null. That makes the row unreachable by the
 * owner-side sweep in `media:prune`, and unreachable by the file-side
 * sweep too, since the row exists and its path is therefore known. The
 * only way to answer "is this row still referenced" is to ask the tables
 * holding the keys, and this package does not own them: `media` cannot
 * know that `users.avatar_id` exists, and must not, which is the whole
 * reason there are no foreign keys on the `media` table.
 *
 * So the application declares them. One entry per column.
 */
export interface MediaReference {
  /** The table holding the foreign key, e.g. `"users"`. */
  table: string;
  /** The column holding a `media.id`, e.g. `"avatar_id"`. */
  column: string;
  /** The connection the table lives on, for an app with more than one. */
  connection?: string;
}

const references: MediaReference[] = [];

/**
 * Declare that `table.column` holds a `media.id`.
 *
 * Call it from the owning model's provider `boot()`, next to the model
 * that declares the `belongsToMedia` builder:
 *
 *   registerMediaReference({ table: "users", column: "avatar_id" });
 *
 * That is what lets `media:prune` delete a row whose owner was deleted
 * out from under it — without a declaration the row and its bytes leak
 * permanently. It also makes SHARING safe: a row referenced from two
 * registered columns appears in two reference queries and is kept by
 * either, so a content-addressed cache (one stored file, many records)
 * survives a prune.
 *
 * Idempotent per `(connection, table, column)`, so a provider registered
 * twice — which happens in a test harness rebuilding an application per
 * case — does not make the sweep query the same column twice.
 */
export function registerMediaReference(reference: MediaReference): void {
  const exists = references.some(
    (known) =>
      known.table === reference.table &&
      known.column === reference.column &&
      known.connection === reference.connection,
  );

  if (exists) {
    return;
  }

  references.push({ ...reference });
}

/** Every declared reference, in registration order. */
export function mediaReferences(): readonly MediaReference[] {
  return references;
}

/**
 * Forget every declared reference.
 *
 * The registry is module-global rather than container-bound — a
 * provider's `boot()` is the natural call site and it has no per-app
 * registry to write into — so a test that registers one would otherwise
 * leak into the next file. Same role as `Relation.resetMorphMap()`.
 */
export function resetMediaReferences(): void {
  references.length = 0;
}
