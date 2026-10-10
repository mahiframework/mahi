import type { BaseModel, EloquentBuilder } from "@mahiframework/database";
import type { MediaFile } from "../models/media-file.model.js";
import { EMPTY_BLUEPRINT, type MediaBlueprint } from "./blueprint.js";
import { MediaCollection, type AddableMedia } from "./media-collection.js";

/**
 * One file referenced by a foreign key on the OWNER's table.
 *
 *   class User extends Model<UserAttributes>()({ ... }) {
 *     avatar() {
 *       return belongsToMedia(this, "avatar_id")
 *         .accept({ mimes: ["image/*"], maxBytes: 5_000_000 })
 *         .withModifiers([cropToSquare(), resizeDown(512, 512), format("webp")]);
 *     }
 *   }
 *
 *   await user.avatar().set(file);
 *
 * The owner holds the reference, so the media row records NO owner —
 * both `model_type` and `model_id` stay null, which is why the migration
 * makes them nullable.
 *
 * Needs a column on the owner's table, which is the app's migration to
 * write:
 *
 *   table.bigInteger("avatar_id").nullable();
 *
 * AND A DECLARATION, which is the app's provider to write:
 *
 *   registerMediaReference({ table: "users", column: "avatar_id" });
 *
 * That is not optional housekeeping. A row reached only through such a
 * key cannot be found by owner, so without the declaration `media:prune`
 * has no way to tell "still somebody's avatar" from "the user was
 * deleted and this is garbage" — and it keeps both, forever, bytes
 * included. The file sweep does not cover it: the row exists, so its
 * path is known, so its file is not an orphan.
 *
 * SHARING ONE ROW BETWEEN TWO OWNERS is expressible — assign the same id
 * to both columns — and the prune sweep handles it, since a row
 * referenced from either registered column is kept. `delete()` below
 * does NOT: it deletes the referenced row outright, taking the file with
 * it. A shared row must be unpointed by writing the owner's column
 * directly rather than through the builder.
 */
export class BelongsToMedia extends MediaCollection<BelongsToMedia> {
  constructor(
    owner: BaseModel,
    private readonly foreignKey: string,
    blueprint: MediaBlueprint = EMPTY_BLUEPRINT,
  ) {
    super(owner, blueprint);
  }

  protected clone(blueprint: MediaBlueprint): BelongsToMedia {
    return new BelongsToMedia(this.owner, this.foreignKey, blueprint);
  }

  /** The query for the referenced row. */
  query(): EloquentBuilder<Record<string, unknown>> {
    return this.model()
      .query()
      .whereKey(this.currentKey() ?? 0n) as unknown as EloquentBuilder<Record<string, unknown>>;
  }

  /** The referenced file, or undefined when the key is null. */
  async get(): Promise<MediaFile | undefined> {
    const key = this.currentKey();

    if (key === null) {
      return undefined;
    }

    return this.model().find(key);
  }

  /**
   * Replace the referenced file and repoint the key.
   *
   * Order matters: upload, repoint, then delete the old row. The owner
   * therefore never points at a row that does not exist, and a failed
   * upload leaves the previous file in place — the opposite of
   * `hasOneMedia().set()`, which can afford to clear first because
   * nothing holds a reference to break.
   */
  async set(source: AddableMedia): Promise<MediaFile> {
    const previous = await this.get();
    const created = await this.manager().add(source, this.addOptions());

    this.owner.setAttribute(this.foreignKey, created.id);
    await this.owner.save();

    if (previous !== undefined) {
      await previous.deleteInstance();
    }

    return created;
  }

  /**
   * Delete the referenced file and null the key.
   *
   * The key is cleared BEFORE the row goes, so a foreign key constraint
   * on the owner's column — which an app may well have added — is never
   * briefly violated.
   *
   * ASSUMES THE REFERENCE IS EXCLUSIVE. The row is deleted outright, so
   * a second owner pointing at the same id loses its file. An app that
   * shares rows nulls the column itself and lets `media:prune`'s
   * reference sweep decide when the row is genuinely unreferenced.
   */
  async delete(): Promise<void> {
    const existing = await this.get();

    this.owner.setAttribute(this.foreignKey, null);
    await this.owner.save();

    if (existing !== undefined) {
      await existing.deleteInstance();
    }
  }

  /** The owner's current foreign key value, normalised to a bigint. */
  private currentKey(): bigint | null {
    const raw: unknown = this.owner.getRawAttribute(this.foreignKey);

    if (raw === null || raw === undefined || raw === "") {
      return null;
    }

    if (typeof raw === "bigint") {
      return raw;
    }

    if (typeof raw === "number" || typeof raw === "string") {
      // The column should be a bigint — but a driver may hand back a
      // string, and an app may have declared the column as text.
      try {
        return BigInt(raw);
      } catch {
        return null;
      }
    }

    return null;
  }
}

/**
 * `belongsToMedia(this, "avatar_id")` on the owning model.
 *
 * @param foreignKey the column on the OWNER's table holding the media id.
 */
export function belongsToMedia(owner: BaseModel, foreignKey: string): BelongsToMedia {
  return new BelongsToMedia(owner, foreignKey);
}
