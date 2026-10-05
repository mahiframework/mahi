export { MediaServiceProvider, MEDIA_TOKEN, IMAGE_TOKEN } from "./media-service-provider.js";
export { MediaManager } from "./media-manager.js";
export type { AddMediaOptions } from "./media-manager.js";
export { Media } from "./media-facade.js";

export { MediaFile } from "./models/media-file.model.js";
export type { MediaFileAttributes } from "./models/media-file.model.js";
export { mediaModels, useMediaModels } from "./models/registry.js";
export type { MediaModels } from "./models/registry.js";

// The write side: fluent per-relation builders, declared as METHODS on
// the owning model. See `has-many-media.ts` for why methods and not
// fields or `static relationships`.
export { hasManyMedia, HasManyMedia } from "./builders/has-many-media.js";
export type { SyncItem } from "./builders/has-many-media.js";
export { hasOneMedia, HasOneMedia } from "./builders/has-one-media.js";
export { belongsToMedia, BelongsToMedia } from "./builders/belongs-to-media.js";
export { MediaCollection } from "./builders/media-collection.js";
export type { AddableMedia } from "./builders/media-collection.js";
export { EMPTY_BLUEPRINT, narrowAccept, withBlueprint } from "./builders/blueprint.js";
export type { MediaBlueprint } from "./builders/blueprint.js";

// The read side: a plain morphMany for eager loading. Separate from the
// builders on purpose — see the docstring.
export { mediaRelation } from "./relations.js";

export { MediaEvent, MediaCreated, MediaUpdated, MediaDeleted } from "./events/media-event.js";

export { resolveSource } from "./media-source.js";
export type { MediaSource, ResolvedSource } from "./media-source.js";

export { resolveConfig, resolveAccept } from "./media-config.js";
export type {
  MediaConfig,
  MediaAcceptConfig,
  MediaHashingConfig,
  MediaImageConfig,
  ResolvedAccept,
  ResolvedMediaConfig,
} from "./media-config.js";

// The image seam. A driver package implements `ImageDriver` and
// registers itself on the `ImageManager` at `IMAGE_TOKEN`; this package
// ships no driver, so an app storing only documents pays for no image
// library.
export { ImageManager } from "./image/image-manager.js";
export { IMAGE_OPS } from "./image/image-driver.js";
export type {
  CropOp,
  EncodeOptions,
  FillOp,
  ImageDriver,
  ImageHandle,
  ImageOp,
  ImageOpType,
  PlaceOp,
  RotateOp,
  ScaleDownOp,
} from "./image/image-driver.js";
export { FakeImageDriver, scaleDown } from "./image/fake-image-driver.js";
export { imageDriverContract } from "./image/testing/image-driver-contract.js";
export type {
  ImageDriverContractCase,
  ImageDriverContractOptions,
} from "./image/testing/image-driver-contract.js";

export {
  cropToSquare,
  format,
  quality,
  resizeDown,
  rotate,
  setBackgroundColor,
  targetMimeType,
} from "./modifiers/index.js";
export { ModifierContext, imageModifier, modifier } from "./pipeline/modifier.js";
export type { MediaModifier } from "./pipeline/modifier.js";
export { runModifiers } from "./pipeline/run-modifiers.js";
export type { ModifiedImage } from "./pipeline/run-modifiers.js";

// The MIME table and the sniffer are exported because an application
// validating an upload before it reaches this package needs the same
// answers it will get afterwards. `looksExecutable` in particular is
// worth running at the request layer.
export {
  DEFAULT_MIME_TYPE,
  extensionForMimeType,
  isRasterImage,
  mimeTypeForExtension,
} from "./support/mime.js";
export { looksExecutable, resolveMimeType, sniffMimeType } from "./support/sniff.js";
export { checksum, checksumStream, isSupportedAlgorithm } from "./support/checksum.js";
export { PathGenerator, sanitiseFilename } from "./support/path-generator.js";

// A streaming, zero-dependency zip writer. Returns a stream rather than
// a response, because this package does not depend on `http` and the app
// owns the authorization and caching decisions anyway.
export { MediaZip, EmptyArchiveError } from "./zip/media-zip.js";
export { zipStream, uniqueName } from "./zip/zip-stream.js";
export type { ZipEntry } from "./zip/zip-stream.js";

export { MediaPruneCommand } from "./commands/media-prune.js";
export { MediaCheckCommand } from "./commands/media-check.js";

export {
  MediaError,
  MediaChecksumMismatchError,
  MediaTooLargeError,
  NoImageDriverError,
  UnacceptableMediaTypeError,
  UndecodableImageError,
  UnreadableMediaSourceError,
  UnsupportedImageOpError,
} from "./errors.js";
