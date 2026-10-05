import { morphMany } from "@mahiframework/database";
import { mediaModels } from "./models/registry.js";

/**
 * The `media` relation, for an app model that wants to eager-load it.
 *
 * Opt-in per model rather than shipped on anything, because the package
 * owns neither the app's models nor its attribute interfaces:
 *
 *   export interface PostAttributes {
 *     // ...
 *     media: MorphMany<MediaFile>;
 *   }
 *
 *   export class Post extends Model<PostAttributes>()({ ... }) {
 *     static override relationships = {
 *       media: mediaRelation(),
 *     };
 *   }
 *
 * That buys `Post.query().with("media")` and
 * `whereHas("media", (q) => q.where("collection", "photos"))`.
 *
 * THIS IS THE READ SIDE ONLY, and it is a separate thing from the
 * builders. `post.media()` — the `hasManyMedia` builder — writes files
 * and carries a collection, a disk, accept rules and modifiers from one
 * declaration; this is a plain relation that eager-loads rows. Declare
 * both if you want both, under different names:
 *
 *   static override relationships = { media: mediaRelation() };
 *   photos() { return hasManyMedia(this).collection("photos"); }
 *
 * A collection filter cannot live in here: `MorphManyOptions` has no
 * constraint field, by design. Filter at query time instead —
 * `with({ media: (q) => q.where("collection", "photos") })` — or use
 * `MediaFile.inCollection()`.
 *
 * `type` is deliberately omitted so it defaults to the DECLARING model's
 * `morphAlias()`, which is what a `morphMany` wants. Note that
 * `morphAlias()` falls back to the TABLE NAME, so an app without a
 * `Relation.morphMap()` entry or a `static morphName` has made its media
 * rows depend on its table name — and media rows outlive table renames.
 */
export function mediaRelation() {
  return morphMany(() => mediaModels.media, {
    morphType: "model_type",
    morphId: "model_id",
  });
}
