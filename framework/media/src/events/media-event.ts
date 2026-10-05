import { AbstractEvent } from "@mahiframework/events";
import type { MediaFile } from "../models/media-file.model.js";

/**
 * Base class for every event this package fires.
 *
 * Abstract and shared so ONE registration catches all of them, and any
 * added later:
 *
 *   events.listen(MediaEvent, AuditMediaListener);
 *
 * The dispatcher matches with `instanceof`, which is what makes that
 * work — the same reason `@mahiframework/auth` has an abstract
 * `AuthEvent` over its fourteen subclasses.
 */
export abstract class MediaEvent extends AbstractEvent {
  /**
   * The row the event concerns.
   *
   * Typed as a `MediaFile` because that is what every path in this
   * package produces: `created` and `updated` carry the saved instance,
   * and `deleted` carries the row the delete loaded. The one shape the
   * ORM can hand over instead is a bare `{ id }` payload, for a static
   * `delete()` that found no row — and in that case there is nothing to
   * have an event about, so it is not a case a listener has to defend
   * against.
   */
  constructor(readonly media: MediaFile) {
    super();
  }
}

/**
 * A media row was created and its file is on the disk.
 *
 * Fired after the write, never before: a listener that queues a virus
 * scan or a transcode needs the bytes to be there. Dispatched through
 * the model's `dispatchesEvents`, so it also covers a row an application
 * created by hand.
 */
export class MediaCreated extends MediaEvent {
  static override eventName = "media.MediaCreated";
}

/**
 * A media row's attributes changed.
 *
 * This is metadata — a reorder, an edited alt text, a replaced file's
 * new checksum. The bytes are not necessarily different.
 */
export class MediaUpdated extends MediaEvent {
  static override eventName = "media.MediaUpdated";
}

/**
 * A media row was deleted.
 *
 * Fired AFTER the row and its file are gone, so `media.path` names
 * something that no longer exists — which is the point for a listener
 * that mirrors deletions to a CDN or a search index.
 *
 * File cleanup itself does NOT hang off this event. It runs in the
 * model's `deleting` hook, because that still has the loaded row and
 * runs inside whatever transaction the caller opened. A listener here
 * firing after a rollback would have deleted a file whose row came back.
 */
export class MediaDeleted extends MediaEvent {
  static override eventName = "media.MediaDeleted";
}
