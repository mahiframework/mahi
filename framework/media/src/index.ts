export { MediaServiceProvider, MEDIA_TOKEN, IMAGE_TOKEN } from "./media-service-provider.js";
export { MediaManager } from "./media-manager.js";
export type { AddMediaOptions } from "./media-manager.js";
export { Media } from "./media-facade.js";

export { MediaFile } from "./models/media-file.model.js";
export type { MediaFileAttributes } from "./models/media-file.model.js";
export { mediaModels, useMediaModels } from "./models/registry.js";
export type { MediaModels } from "./models/registry.js";

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
