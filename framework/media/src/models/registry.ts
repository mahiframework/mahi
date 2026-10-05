import { MediaFile } from "./media-file.model.js";

/**
 * The model classes this package reads and writes through.
 *
 * One mutable object rather than direct imports, so an application can
 * point the `media` table at its own subclass and have the PACKAGE's own
 * queries produce it — needed when the subclass adds a `NOT NULL` column
 * the package has to populate, or carries a global scope that must apply
 * to the package's reads too. See `docs/extending-models`.
 */
export interface MediaModels {
  media: typeof MediaFile;
}

export const mediaModels: MediaModels = {
  media: MediaFile,
};

/**
 * Point the `media` table at an application-provided subclass.
 *
 * Call this before `app.bootstrap()`, from a service provider's
 * `register()`. Calling it later is not wrong so much as partial:
 * anything already read through the old class stays an instance of it.
 *
 *   export class AppMediaFile extends MediaFile {
 *     get altText(): string {
 *       return (this.custom_properties?.alt as string) ?? "";
 *     }
 *   }
 *
 *   useMediaModels({ media: AppMediaFile });
 *
 * Typed `typeof MediaFile`, not `AnyModelClass`. `AnyModelClass` is
 * `typeof BaseModel`, which carries no attribute type, so every static on
 * it degrades to `any` and the package would lose column checking on its
 * own table — `create({ utter: "nonsense" })` would compile. `typeof
 * MediaFile` keeps those errors and additionally makes "must be a
 * subclass of `MediaFile`" a compile-time guarantee.
 */
export function useMediaModels(overrides: Partial<MediaModels>): void {
  Object.assign(mediaModels, overrides);
}
