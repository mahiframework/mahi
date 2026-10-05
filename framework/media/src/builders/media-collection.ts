import { app } from "@mahiframework/core";
import type { BaseModel, EloquentBuilder } from "@mahiframework/database";
import { MEDIA_TOKEN } from "../tokens.js";
import type { MediaManager } from "../media-manager.js";
import type { MediaSource } from "../media-source.js";
import type { MediaFile } from "../models/media-file.model.js";
import { mediaModels } from "../models/registry.js";
import type { MediaModifier } from "../pipeline/modifier.js";
import { targetMimeType } from "../modifiers/index.js";
import {
  narrowAccept,
  resolveAccept,
  withBlueprint,
  type MediaAcceptConfig,
  type MediaBlueprint,
} from "./blueprint.js";

/**
 * The fluent configuration every media relation shares.
 *
 * Each method returns a NEW builder of the same kind, so a per-call
 * override is local to that call. See `MediaBlueprint` for why that
 * matters.
 *
 * Subclasses supply the owner link — `clone()` is the single abstract
 * point, which is what lets the three relation kinds share all of this
 * while differing in where the foreign key lives.
 */
export abstract class MediaCollection<TSelf extends MediaCollection<TSelf>> {
  protected constructor(
    protected readonly owner: BaseModel,
    protected readonly blueprint: MediaBlueprint,
  ) {}

  /** A copy of this builder carrying `blueprint`. */
  protected abstract clone(blueprint: MediaBlueprint): TSelf;

  /**
   * Scope this relation to a named collection.
   *
   * DOUBLE DUTY, which is the neatest idea in laravel-media and worth
   * porting exactly: it both tags writes and constrains reads. One
   * declaration therefore makes `get()` return only this collection and
   * `add()` stamp it, with no chance of the two disagreeing.
   */
  collection(name: string | null): TSelf {
    return this.clone(withBlueprint(this.blueprint, { collection: name }));
  }

  /** Write new files to a named disk instead of the configured default. */
  disk(name: string | null): TSelf {
    return this.clone(withBlueprint(this.blueprint, { disk: name }));
  }

  /**
   * A path prefix under the disk root.
   *
   * Named `rootPath` rather than `path`, matching laravel-media: `path`
   * on a builder would read as the file's own path rather than the
   * prefix files are placed under.
   */
  rootPath(prefix: string | null): TSelf {
    return this.clone(withBlueprint(this.blueprint, { path: prefix }));
  }

  /** Override the stored download name. Sanitised either way. */
  filename(name: string | null): TSelf {
    return this.clone(withBlueprint(this.blueprint, { filename: name }));
  }

  /**
   * Restrict what may be uploaded here.
   *
   * NARROWS the app-wide `media.accept` floor; it cannot widen it. A
   * relation may refuse more than config does but never less — see
   * `narrowAccept()`.
   */
  accept(rules: MediaAcceptConfig): TSelf {
    return this.clone(withBlueprint(this.blueprint, { accept: resolveAccept(rules) }));
  }

  /** Transformations applied to images before they are stored. */
  withModifiers(modifiers: readonly MediaModifier[]): TSelf {
    return this.clone(withBlueprint(this.blueprint, { modifiers }));
  }

  /** Custom properties stamped on every file added here. */
  withCustomProperties(properties: Record<string, unknown>): TSelf {
    return this.clone(withBlueprint(this.blueprint, { customProperties: properties }));
  }

  /** The query for this relation, for reads beyond `get()`. */
  abstract query(): EloquentBuilder<Record<string, unknown>>;

  /** The media manager, resolved per call rather than held. */
  protected manager(): MediaManager {
    return app().make<MediaManager>(MEDIA_TOKEN);
  }

  /**
   * The owner's morph alias and stringified key.
   *
   * Read at CALL time, never when the builder is constructed. That is
   * what lets `photos()` be declared as a method on a model whose
   * attributes are assigned after construction, and it means a builder
   * captured before a `save()` still works after it.
   */
  protected ownerRef(): { type: string; id: string } {
    const type = (this.owner.constructor as typeof BaseModel).morphAlias();

    return { type, id: String(this.owner.getKey()) };
  }

  /** Options for `MediaManager.add()`, from the blueprint. */
  protected addOptions(extra: { order?: number } = {}): Parameters<MediaManager["add"]>[1] {
    return {
      collection: this.blueprint.collection,
      disk: this.blueprint.disk,
      path: this.blueprint.path,
      filename: this.blueprint.filename ?? undefined,
      accept: narrowAccept(this.manager().config.accept, this.blueprint.accept),
      modifiers: this.blueprint.modifiers,
      customProperties: this.blueprint.customProperties,
      ...extra,
    };
  }

  /**
   * The mime type a file added here will end up with.
   *
   * Exposed so a caller can know the answer before uploading — a form
   * that shows "will be converted to WebP", for one.
   */
  resultingMimeType(sourceMimeType: string): string {
    return targetMimeType(this.blueprint.modifiers, sourceMimeType);
  }

  /** The model class this relation reads and writes, honouring a swap. */
  protected model(): typeof MediaFile {
    return mediaModels.media;
  }

  /** Delete rows and their files, one at a time so each hook runs. */
  protected async deleteAll(rows: readonly MediaFile[]): Promise<void> {
    for (const row of rows) {
      await row.deleteInstance();
    }
  }

  /** Narrow a query to this relation's collection, if it has one. */
  protected scopeToCollection<T extends { where(column: string, value: unknown): T }>(query: T): T {
    return this.blueprint.collection === null
      ? query
      : query.where("collection", this.blueprint.collection);
  }
}

/** Anything the builders accept as "a file to add". */
export type AddableMedia = MediaSource;
