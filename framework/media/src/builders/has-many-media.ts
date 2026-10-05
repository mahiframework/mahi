import { collect, type Collection } from "@mahiframework/core";
import { transaction, type BaseModel, type EloquentBuilder } from "@mahiframework/database";
import type { MediaFile } from "../models/media-file.model.js";
import { EMPTY_BLUEPRINT, type MediaBlueprint } from "./blueprint.js";
import { MediaCollection, type AddableMedia } from "./media-collection.js";

/** An id of an existing row, or a new file to upload. */
export type SyncItem = string | number | bigint | AddableMedia;

/**
 * Many files owned by one record, ordered.
 *
 * Declared as a METHOD on the owning model:
 *
 *   class User extends Model<UserAttributes>()({ ... }) {
 *     photos() {
 *       return hasManyMedia(this)
 *         .collection("photos")
 *         .withModifiers([resizeDown(2000, 2000)])
 *         .keepLatest(10);
 *     }
 *   }
 *
 *   await user.photos().add(file);
 *   await user.photos().sync([id1, newFile, id2]);
 *
 * A method rather than a field, for two reasons found by reading the
 * ORM. `Model.hydrate()` assigns attributes AFTER calling the
 * constructor, so a field initialiser would run against a row with no
 * `id` — survivable only by deferring every key read. And a field
 * depends on `useDefineForClassFields` being true: under the assignment
 * semantics it would hit the model proxy's `set` trap, become a
 * dirty-tracked attribute, and make the next `save()` try to write a
 * `photos` column.
 *
 * A method also sidesteps `static relationships`, which cannot express
 * this at all: `Relationships<A>` is a total mapped type over the
 * attribute interface's relation keys, so a relation must be declared
 * there as a marker — and these builders are not relations, they are
 * writers that happen to read.
 */
export class HasManyMedia extends MediaCollection<HasManyMedia> {
  constructor(owner: BaseModel, blueprint: MediaBlueprint = EMPTY_BLUEPRINT) {
    super(owner, blueprint);
  }

  protected clone(blueprint: MediaBlueprint): HasManyMedia {
    return new HasManyMedia(this.owner, blueprint);
  }

  /**
   * Keep only the newest `limit` files, deleting the rest on `add()`.
   *
   * For a gallery with a cap: adding an eleventh photo to a
   * `keepLatest(10)` collection removes the oldest, file and all.
   */
  keepLatest(limit: number | null): HasManyMedia {
    return this.clone({ ...this.blueprint, keepLatest: limit });
  }

  /**
   * The query for this relation, in collection order.
   *
   * Built from the model's own ad-hoc `morphMany()`, which takes its
   * options inline and so needs no `static relationships` entry. The key
   * is stringified because `media.model_id` is TEXT — that is what lets
   * any model own media regardless of how it keys, and the ORM would
   * otherwise bind a `bigint` against a `varchar`.
   */
  query(): EloquentBuilder<Record<string, unknown>> {
    const { type, id } = this.ownerRef();

    const query = this.model()
      .query()
      .where("model_type", type)
      .where("model_id", id)
      .orderBy("order", "asc");

    return this.scopeToCollection(query) as unknown as EloquentBuilder<Record<string, unknown>>;
  }

  /** Every file in this collection, in order. */
  async get(): Promise<Collection<MediaFile>> {
    const { type, id } = this.ownerRef();

    const query = this.model()
      .query()
      .where("model_type", type)
      .where("model_id", id)
      .orderBy("order", "asc");

    return this.scopeToCollection(query).get();
  }

  /** How many files this collection holds. */
  async count(): Promise<number> {
    const { type, id } = this.ownerRef();

    const query = this.model().query().where("model_type", type).where("model_id", id);

    return this.scopeToCollection(query).count();
  }

  /**
   * Append one or more files.
   *
   * Ordering continues from the current maximum, so the first file in a
   * fresh collection is `order` 1 and nothing is ever 0 — which keeps
   * "unordered" (the column default) distinguishable from "first".
   */
  async add(source: AddableMedia | readonly AddableMedia[]): Promise<Collection<MediaFile>> {
    const sources = Array.isArray(source) ? source : [source as AddableMedia];
    const owner = this.ownerRef();
    const added: MediaFile[] = [];

    let order = await this.highestOrder();

    for (const entry of sources) {
      order += 1;

      added.push(await this.manager().add(entry, { ...this.addOptions({ order }), owner }));
    }

    await this.enforceKeepLatest();

    return collect(added);
  }

  /**
   * Replace the whole collection with an ordered list.
   *
   * The best DX in laravel-media and ported in full: one array mixing
   * ids of rows to keep with new files to upload, in the order they
   * should end up.
   *
   *   await user.photos().sync([existingId, newFile, otherExistingId]);
   *
   * New files are uploaded first and take the slot they occupied, then
   * every surviving row is renumbered in payload order, and anything
   * absent from the payload is deleted.
   *
   * WRAPPED IN A TRANSACTION, which laravel-media's is not — a failure
   * part-way through its renumbering leaves a gallery with duplicate and
   * missing order values and no way to tell which. File deletions are
   * deferred until after the commit for the same reason: a rolled-back
   * transaction must not have deleted bytes whose rows came back.
   */
  async sync(items: readonly SyncItem[]): Promise<Collection<MediaFile>> {
    const owner = this.ownerRef();
    const existing = (await this.get()).all();
    const byId = new Map(existing.map((row) => [String(row.id), row]));

    // Uploads happen OUTSIDE the transaction. They write to a disk,
    // which cannot be rolled back, and holding a transaction open across
    // a multi-megabyte upload would pin a connection for the duration.
    const resolved: { row: MediaFile; keep: boolean }[] = [];

    for (const item of items) {
      const asId = typeof item === "string" || typeof item === "number" || typeof item === "bigint";
      const found = asId ? byId.get(String(item)) : undefined;

      if (found !== undefined) {
        resolved.push({ row: found, keep: true });
        byId.delete(String(item));

        continue;
      }

      if (asId) {
        // An id naming a row this collection does not hold. Skipped
        // rather than fatal: the common cause is a stale form posting an
        // id someone else deleted, and failing the whole sync over it
        // would lose the user's other edits.
        continue;
      }

      resolved.push({
        row: await this.manager().add(item, { ...this.addOptions(), owner }),
        keep: false,
      });
    }

    // Whatever is still in the map was absent from the payload.
    const doomed = [...byId.values()];

    await transaction(this.model().resolveConnection(), async () => {
      let order = 0;

      for (const entry of resolved) {
        order += 1;

        if (entry.row.order !== order) {
          entry.row.order = order;
          await entry.row.save();
        }
      }

      for (const row of doomed) {
        await this.model().query().whereKey(row.id).delete();
      }
    });

    // Files last, once the row changes are committed.
    for (const row of doomed) {
      await this.manager().deleteFile(row.disk, row.path);
    }

    return collect(resolved.map((entry) => entry.row));
  }

  /**
   * Replace the collection from a request's own fields.
   *
   * Merges `request.input(key)` with `request.files(key)` by their
   * ORIGINAL INDEX, which is what lets one HTML form submit "keep #5,
   * here is a new file, keep #2" as a single ordered array.
   *
   * Takes a structural request rather than
   * `@mahiframework/http`'s — this package does not depend on `http`,
   * and anything with these two methods works.
   */
  async syncFromRequest(
    request: {
      input(key: string): unknown;
      files(key: string): readonly AddableMedia[];
    },
    key: string,
  ): Promise<Collection<MediaFile>> {
    const ids = request.input(key);
    const files = request.files(key);
    const items: SyncItem[] = [];

    // Ids arrive as a sparse-ish array where the slots holding new files
    // are empty, so walking the ids and filling gaps from the file list
    // preserves the submitted order.
    const idList = Array.isArray(ids) ? ids : [];
    let fileIndex = 0;

    for (const entry of idList) {
      if (entry === null || entry === undefined || entry === "") {
        const file = files[fileIndex++];

        if (file !== undefined) {
          items.push(file);
        }

        continue;
      }

      items.push(entry as SyncItem);
    }

    // Any files beyond the id list's length are appended.
    for (; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];

      if (file !== undefined) {
        items.push(file);
      }
    }

    return this.sync(items);
  }

  /** Delete every file in this collection, rows and bytes. */
  async delete(): Promise<void> {
    await this.deleteAll((await this.get()).all());
  }

  /** The current highest `order`, or 0 for an empty collection. */
  private async highestOrder(): Promise<number> {
    const rows = (await this.get()).all();

    return rows.reduce((highest, row) => Math.max(highest, row.order), 0);
  }

  /** Trim to `keepLatest`, deleting the oldest rows and their files. */
  private async enforceKeepLatest(): Promise<void> {
    const limit = this.blueprint.keepLatest;

    if (limit === null || limit <= 0) {
      return;
    }

    const rows = (await this.get()).all();

    if (rows.length <= limit) {
      return;
    }

    // Oldest first by `order`, which `get()` already sorted by.
    await this.deleteAll(rows.slice(0, rows.length - limit));
  }
}

/** `hasManyMedia(this)` on the owning model. */
export function hasManyMedia(owner: BaseModel): HasManyMedia {
  return new HasManyMedia(owner);
}
