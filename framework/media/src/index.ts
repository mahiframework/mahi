export { MediaServiceProvider, MEDIA_TOKEN } from "./media-service-provider.js";
export { MediaManager } from "./media-manager.js";

export { MediaFile } from "./models/media-file.model.js";
export type { MediaFileAttributes } from "./models/media-file.model.js";
export { mediaModels, useMediaModels } from "./models/registry.js";
export type { MediaModels } from "./models/registry.js";

export { resolveConfig, resolveAccept } from "./media-config.js";
export type {
  MediaConfig,
  MediaAcceptConfig,
  MediaHashingConfig,
  ResolvedAccept,
  ResolvedMediaConfig,
} from "./media-config.js";

export {
  MediaError,
  MediaChecksumMismatchError,
  MediaTooLargeError,
  UnacceptableMediaTypeError,
  UnreadableMediaSourceError,
} from "./errors.js";
