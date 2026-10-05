export { MediaServiceProvider, MEDIA_TOKEN } from "./media-service-provider.js";
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
  ResolvedAccept,
  ResolvedMediaConfig,
} from "./media-config.js";

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
  UnacceptableMediaTypeError,
  UnreadableMediaSourceError,
} from "./errors.js";
