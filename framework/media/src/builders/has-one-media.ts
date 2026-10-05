import type { BaseModel, EloquentBuilder } from "@mahiframework/database";
import type { MediaFile } from "../models/media-file.model.js";
import { EMPTY_BLUEPRINT, type MediaBlueprint } from "./blueprint.js";
import { MediaCollection, type AddableMedia } from "./media-collection.js";

/**
 * One file owned by a record, with the link on the MEDIA row.
 *
 *   class Tenant extends Model<TenantAttributes>()({ ... }) {
 *     logo() {
 *       return hasOneMedia(this)
 *         .collection("logo")
 *         .accept({ mimes: ["image/*"], maxBytes: 2_000_000 });
 *     }
 *   }
 *
 *   await tenant.logo().set(file);
 *   const logo = await tenant.logo().get();
 *
 * Choose this over `belongsToMedia` when the owner's table should not
 * grow a column — it needs no migration on the owner's side, and it
 * generalises to "one logo per tenant per collection" for free. Choose
 * `belongsToMedia` when you want a real foreign key, which an
 * owner-side `NOT NULL` or a join can rely on.
 */
export class HasOneMedia extends MediaCollection<HasOneMedia> {
  constructor(owner: BaseModel, blueprint: MediaBlueprint = EMPTY_BLUEPRINT) {
    super(owner, blueprint);
  }

  protected clone(blueprint: MediaBlueprint): HasOneMedia {
    return new HasOneMedia(this.owner, blueprint);
  }

  /**
   * The query for this relation.
   *
   * The owner's key is stringified because `media.model_id` is TEXT,
   * which is what lets any model own media regardless of key type.
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

  /** The file, or undefined. */
  async get(): Promise<MediaFile | undefined> {
    const { type, id } = this.ownerRef();

    const query = this.model().query().where("model_type", type).where("model_id", id);

    return this.scopeToCollection(query).first();
  }

  /**
   * Replace the file.
   *
   * The old row and its bytes go first, so there is never a moment with
   * two rows satisfying a one-to-one relation. The cost is a window
   * where the relation is empty if the upload then fails — acceptable
   * for a logo, and the alternative (upload, swap, delete) would need a
   * transaction spanning a disk write, which cannot roll back.
   */
  async set(source: AddableMedia): Promise<MediaFile> {
    await this.delete();

    return this.manager().add(source, { ...this.addOptions(), owner: this.ownerRef() });
  }

  /** Delete the file, if there is one. */
  async delete(): Promise<void> {
    const existing = await this.get();

    if (existing !== undefined) {
      await existing.deleteInstance();
    }
  }
}

/** `hasOneMedia(this)` on the owning model. */
export function hasOneMedia(owner: BaseModel): HasOneMedia {
  return new HasOneMedia(owner);
}
