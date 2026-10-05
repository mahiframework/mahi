import { Facade } from "@mahiframework/facades";
import type { StorageDriver } from "@mahiframework/storage";
import type { AddMediaOptions, MediaManager } from "./media-manager.js";
import type { MediaSource } from "./media-source.js";
import type { MediaFile } from "./models/media-file.model.js";
import { MEDIA_TOKEN } from "./tokens.js";

/**
 * Thin facade over the `MediaManager` singleton bound at `MEDIA_TOKEN`,
 * for call sites that would otherwise read
 * `app().make<MediaManager>(MEDIA_TOKEN).add(...)`.
 *
 *   const logo = await Media.add(file, { collection: "logos" });
 *   await Media.add(buffer, { owner: { type: "User", id: user.id } });
 *
 * Named `Media` (the collective) while the model is `MediaFile` (one
 * row). `Media.add()` reads better than `MediaFiles.add()`, and
 * `MediaFile.find(id)` reads better than `Media.find(id)` — a bare
 * `media` is a mass noun, so a single row under that name is a small
 * lie that every call site repeats.
 *
 * PREFER THE RELATION BUILDERS for anything owned by a model:
 * `user.photos().add(file)` carries the collection, the disk and the
 * accept rules from one declaration, where this takes them per call.
 * This is the model-less path — a seeder, a queue job holding only
 * `{ type, id }`, an import script.
 *
 * Otherwise the usual guidance: prefer constructor-injecting
 * `MediaManager` via `MEDIA_TOKEN` where that is practical, and use this
 * where threading `app` through is genuinely inconvenient.
 */
export class Media extends Facade<MediaManager>(() => MEDIA_TOKEN) {
  /**
   * Store a file and record it.
   *
   * Validates, writes the file, then inserts the row — in that order,
   * so a rejected upload touches neither and a failed write leaves no
   * row pointing at missing bytes.
   */
  static add(source: MediaSource, options?: AddMediaOptions): Promise<MediaFile> {
    return this.instance().add(source, options);
  }

  /** Delete a row and its file. */
  static delete(media: MediaFile): Promise<void> {
    return this.instance().delete(media);
  }

  /** The storage driver for a disk name, or for the configured default. */
  static disk(disk?: string | null): StorageDriver {
    return this.instance().disk(disk);
  }

  /** Whether files on a disk have public URLs. */
  static isPublic(disk?: string | null): boolean {
    return this.instance().isPublic(disk);
  }
}
