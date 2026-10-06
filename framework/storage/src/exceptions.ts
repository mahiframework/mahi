/**
 * Thrown when a read-oriented operation (`readStream`, `size`,
 * `lastModified`, `copy`/`move` source, …) targets a path that does not
 * exist on the disk. Laravel raises a `FileNotFoundException` in the same
 * situations; the point of a typed error is that a caller can distinguish
 * "no such file" from a path-traversal rejection (a plain `Error`) or a
 * late `ENOENT` surfacing mid-stream.
 *
 * `readStream()` in particular `stat`s up front and rejects with this
 * *before* handing back a `Readable`, so consumers never have to attach an
 * error handler just to learn the file was missing.
 */
export class FileNotFoundException extends Error {
  constructor(path: string) {
    super(`File [${path}] does not exist.`);
    this.name = "FileNotFoundException";
  }
}

/**
 * Thrown when a driver is asked for something its backend cannot do:
 * `symlink()` on S3, where an object store has no such concept, or
 * `hardlink()` over SFTP against a server lacking
 * `hardlink@openssh.com`.
 *
 * Typed, and carrying `driver`/`feature` as fields, because the
 * alternative for a caller that wants to degrade gracefully (link where
 * possible, copy otherwise) is matching on a message string. The
 * remaining "this disk can't do that" cases — `url()` on a private disk,
 * `path()` on a remote one — predate this and still throw a plain
 * `Error`; `supportsLink()` is the ask-first route that avoids needing a
 * `catch` at all.
 */
export class UnsupportedDriverFeatureException extends Error {
  constructor(
    readonly driver: string,
    readonly feature: string,
    remedy?: string,
  ) {
    super(
      `The ${driver} driver does not support ${feature}.` +
        (remedy === undefined ? "" : ` ${remedy}`),
    );
    this.name = "UnsupportedDriverFeatureException";
  }
}
