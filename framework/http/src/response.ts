import { readFile, unlink } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { expiredCookie, serializeCookie, type CookieOptions } from "./cookies.js";

/**
 * The platform's global `Response`, aliased so this module can shadow the
 * name with the framework class below (same shadowing Laravel does with
 * `Illuminate\Http\Response`).
 *
 * Note the framework class is exported as **`HttpResponse`**, not
 * `Response`. See `index.ts`. The global name is deliberately left
 * alone for consumers, so a handler can still `return Response.json(...)`
 * and mean the Web standard one. When you have an `HttpResponse` and
 * need the raw Web response, call `.toWeb()`.
 */
type WebResponse = InstanceType<typeof globalThis.Response>;
const WebResponse: typeof globalThis.Response = globalThis.Response;

/** Body payloads the base `Response` can hold before serialization. */
export type BodyContent = string | Uint8Array | null;

/**
 * What a route handler / middleware pipe may return: either a framework
 * `Response` (converted to a `WebResponse` at the Hono boundary) or an
 * already-global `WebResponse` (passed straight through). Existing code
 * returning `Response.json(...)` (the global) keeps working unchanged.
 */
export type ResponseInput = HttpResponse | WebResponse;

/**
 * Normalize a handler/pipe result into a platform `WebResponse`. Framework
 * `Response` instances are serialized via `toWeb()`; anything else is
 * assumed to already be a global `Response` and passed through. Called at
 * the Hono edges (`Route.toHonoHandler`, `toHonoMiddleware`).
 */
export function toWebResponse(value: ResponseInput): WebResponse | Promise<WebResponse> {
  return value instanceof HttpResponse ? value.toWeb() : value;
}

/**
 * Outgoing HTTP response. The object handlers return and middleware
 * receives on the way back out. A builder (NOT a subclass of the global
 * `Response`, whose body is immutable once constructed), giving mutable
 * `setContent`/`getContent`, fluent `header()`/`status()`, and typed
 * subclasses (`JsonResponse`, `FileResponse`, `RedirectResponse`).
 *
 * Doubles as a static factory, mirroring Laravel's
 * `response()->json()/file()/redirectTo()`:
 *
 *   return Response.json({ ok: true }, 201);
 *   return Response.file("/tmp/report.pdf").download();
 *   return Response.redirect("/login");
 *
 * `headers` is a real `Headers` instance so middleware can keep mutating
 * it on egress (`res.headers.set(...)`), exactly as it did with the global
 * `Response`. Conversion to a `WebResponse` happens once, at the boundary,
 * via `toWeb()`.
 */
export class HttpResponse {
  protected content: BodyContent;
  public headers: Headers;
  protected statusCode: number;

  constructor(content: BodyContent = "", status = 200, headers: Record<string, string> = {}) {
    this.content = content;
    this.statusCode = status;
    this.headers = new Headers(headers);
  }

  /** Plain response, Laravel's `response($content, $status, $headers)`. */
  static make(
    content: BodyContent = "",
    status = 200,
    headers: Record<string, string> = {},
  ): HttpResponse {
    return new HttpResponse(content, status, headers);
  }

  /** JSON response. `body` is stored un-serialized so `getJson()` returns the value. */
  static json(body: unknown, status = 200, headers: Record<string, string> = {}): JsonResponse {
    return new JsonResponse(body, status, headers);
  }

  /** File/stream response. Accepts a filesystem path, `File`/`Blob`, or `Buffer`/`Uint8Array`. */
  static file(
    fileOrStream: FileSource,
    status = 200,
    headers: Record<string, string> = {},
  ): FileResponse {
    return new FileResponse(fileOrStream, status, headers);
  }

  /** Redirect response. Sets `Location` and a 3xx status (302 by default). */
  static redirect(
    destination: string,
    status = 302,
    headers: Record<string, string> = {},
  ): RedirectResponse {
    return new RedirectResponse(destination, status, headers);
  }

  setContent(content: BodyContent): this {
    this.content = content;

    return this;
  }

  getContent(): BodyContent {
    return this.content;
  }

  /** Set the HTTP status code (fluent). */
  status(code: number): this {
    this.statusCode = code;

    return this;
  }

  getStatus(): number {
    return this.statusCode;
  }

  /** Set a single header (fluent). */
  header(key: string, value: string): this {
    this.headers.set(key, value);

    return this;
  }

  /** Merge many headers at once (fluent). */
  withHeaders(headers: Record<string, string>): this {
    for (const [key, value] of Object.entries(headers)) {
      this.headers.set(key, value);
    }

    return this;
  }

  getHeader(key: string): string | null {
    return this.headers.get(key);
  }

  /**
   * Attach a cookie to this response (fluent).
   *
   * Appends rather than sets, so several cookies on one response each get
   * their own `Set-Cookie` header instead of being collapsed into one
   * malformed value, the failure `Headers.set()` produces silently.
   *
   *   return HttpResponse.json({ ok: true })
   *     .cookie("theme", "dark", { maxAge: 31_536_000 });
   *
   * For a cookie that must be set from a *pipe or guard* rather than a
   * handler, queue it on the request instead (`request.queueCookie()`).
   * That survives whatever response the handler ultimately returns.
   */
  cookie(name: string, value: string, options: CookieOptions = {}): this {
    this.headers.append("Set-Cookie", serializeCookie(name, value, options));

    return this;
  }

  /**
   * Attach a cookie deletion (fluent). `path`/`domain` must match the
   * ones the cookie was written with or the browser keeps the original.
   */
  forgetCookie(name: string, options: CookieOptions = {}): this {
    this.headers.append("Set-Cookie", expiredCookie(name, options));

    return this;
  }

  /**
   * The boundary conversion: build the platform `WebResponse`. Subclasses
   * override to serialize their payload first. Returns a promise where the
   * body must be resolved asynchronously (e.g. `FileResponse` reading off
   * disk).
   */
  toWeb(): WebResponse | Promise<WebResponse> {
    return new WebResponse(this.content, {
      status: this.statusCode,
      headers: this.headers,
    });
  }
}

/**
 * Render a `bigint` as a decimal string during serialization.
 *
 * `JSON.stringify` throws on a `bigint` outright ("Do not know how to
 * serialize a BigInt"), and 64-bit ids are now `bigint`, so without this
 * every response carrying a model id would be a 500.
 *
 * A string rather than a number because the whole reason these are
 * `bigint` is that they do not fit a double: `JSON.parse` on the client
 * would round `440463260157395208` to `...200`, which is precisely the
 * corruption this type exists to prevent. Every language's JSON parser
 * handles a string faithfully; none handle a 19-digit number.
 */
function replaceBigints(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * JSON response. Holds the un-serialized payload (Laravel's
 * `JsonResponse::getData()`), so `getJson()` returns the object rather than
 * a string. `toWeb()` serializes via `JSON.stringify`, matching
 * the legacy `json()` helper byte-for-byte.
 */
export class JsonResponse extends HttpResponse {
  protected data: unknown;

  constructor(data: unknown, status = 200, headers: Record<string, string> = {}) {
    super(null, status, headers);
    this.data = data;
  }

  setJson(data: unknown): this {
    this.data = data;

    return this;
  }

  getJson<T = unknown>(): T {
    return this.data as T;
  }

  override toWeb(): WebResponse {
    // `WebResponse.json()` would be equivalent, but it offers no way to
    // pass a replacer, and a `bigint` anywhere in the payload throws.
    const res = new WebResponse(JSON.stringify(this.data, replaceBigints), {
      status: this.statusCode,
      headers: { "content-type": "application/json" },
    });

    // Merge any custom/middleware-set headers over the JSON defaults.
    // `Set-Cookie` is appended, not set: it's the one header that
    // legitimately repeats, and `set()` would collapse several cookies
    // into a single comma-joined value no browser will parse.
    for (const [key, value] of this.headers.entries()) {
      if (key.toLowerCase() === "set-cookie") {
        continue;
      }

      res.headers.set(key, value);
    }

    for (const cookie of this.headers.getSetCookie()) {
      res.headers.append("Set-Cookie", cookie);
    }

    return res;
  }
}

/**
 * Redirect response. Empty body, 3xx status, `Location` header. `toWeb()`
 * builds the response manually (rather than `Response.redirect`) so custom
 * headers and a caller-chosen status are retained.
 */
export class RedirectResponse extends HttpResponse {
  protected targetUrl: string;

  constructor(destination: string, status = 302, headers: Record<string, string> = {}) {
    super(null, status, headers);
    this.targetUrl = destination;
    this.headers.set("Location", destination);
  }

  setRedirectUrl(url: string): this {
    this.targetUrl = url;
    this.headers.set("Location", url);

    return this;
  }

  getRedirectUrl(): string {
    return this.targetUrl;
  }

  override toWeb(): WebResponse {
    return new WebResponse(null, { status: this.statusCode, headers: this.headers });
  }
}

/**
 * Sources a `FileResponse` can serve. A path/`File`/`Blob`/`Uint8Array`
 * is buffered; a Node `Readable` or web `ReadableStream` is streamed
 * through without ever being held in memory (`Content-Length` is then the
 * caller's responsibility, via an explicit header).
 */
export type FileSource = string | File | Blob | Uint8Array | Readable | ReadableStream<Uint8Array>;

/**
 * Tiny extension→MIME map for path-backed files. Unknown extensions become
 * `application/octet-stream`. Duplicated (rather than imported from
 * `@mahiframework/storage`) so `@mahiframework/http` stays independent of it.
 */
const EXTENSION_MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  json: "application/json",
  txt: "text/plain",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  pdf: "application/pdf",
};

function mimeTypeForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";

  return EXTENSION_MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Build an RFC 6266 `Content-Disposition` value.
 *
 * The ASCII fallback strips everything outside a conservative printable
 * range, including the quote and backslash that would otherwise let a
 * crafted filename break out of the quoted string, and collapses path
 * separators, so a name like `../../etc/passwd` cannot suggest a path to
 * a client that naively joins it.
 */
export function contentDisposition(type: "attachment" | "inline", filename?: string): string {
  if (!filename) {
    return type;
  }

  const ascii = filename
    .replace(/[\\/]/g, "_")
    // Anything outside printable ASCII (so: control characters, newlines
    // that would split the header, and every non-Latin script) is
    // replaced here; `filename*` below carries the real bytes.
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");

  const encoded = encodeURIComponent(filename);

  // Emit `filename*` only when it says something `filename` doesn't,
  // for a plain ASCII name the two are identical and the duplicate is
  // noise.
  return ascii === filename
    ? `${type}; filename="${ascii}"`
    : `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * File response. Buffers the source (filesystem path, `File`/`Blob`, or
 * `Buffer`/`Uint8Array`) into the body at `toWeb()` time, sets
 * `Content-Type` (explicit → extension MIME map → `application/octet-stream`)
 * and `Content-Length`, plus optional `Content-Disposition`/`Cache-Control`.
 *
 *   Response.file("/tmp/report.pdf").download("report.pdf");
 *   Response.file("/tmp/scratch.csv").deleteAfterSend();
 *
 * Streaming and a post-flush `deleteAfterSend` guarantee are follow-ups;
 * today the delete fires immediately after the bytes are read into memory.
 */
export class FileResponse extends HttpResponse {
  protected source: FileSource;
  protected explicitContentType: string | undefined;
  protected shouldDeleteAfterSend = false;

  constructor(fileOrStream: FileSource, status = 200, headers: Record<string, string> = {}) {
    super(null, status, headers);
    this.source = fileOrStream;
  }

  setFile(fileOrStream: FileSource): this {
    this.source = fileOrStream;

    return this;
  }

  getFile(): FileSource {
    return this.source;
  }

  /** Override the content type (else derived from a path's extension or a Blob's type). */
  contentType(type: string): this {
    this.explicitContentType = type;

    return this;
  }

  cacheControl(value: string): this {
    this.headers.set("Cache-Control", value);

    return this;
  }

  /**
   * Send as a download, `Content-Disposition: attachment`, with an
   * optional filename.
   *
   * The filename is emitted twice, per RFC 6266: a sanitised ASCII
   * `filename=` for old clients, and `filename*=UTF-8''…` carrying the
   * real name for everything since ~2011. That is what makes a download
   * called `rapport-café.pdf` arrive with its name intact instead of
   * mojibake.
   *
   * It is also the injection fix. The name frequently comes from user
   * input (an uploaded file, a user-titled export), and interpolating it
   * raw into a quoted header value let a `"` close the quote early and
   * append arbitrary header parameters.
   */
  download(filename?: string): this {
    const name = filename ?? this.defaultFilename();
    this.headers.set("Content-Disposition", contentDisposition("attachment", name));

    return this;
  }

  /** Send inline, `Content-Disposition: inline` (the default behaviour). */
  inline(): this {
    this.headers.set("Content-Disposition", "inline");

    return this;
  }

  /**
   * Delete the backing file once its bytes have been read for the response.
   * Only valid for path-backed files, a no-op for `Blob`/`Buffer` sources
   * (there is nothing on disk to unlink).
   */
  deleteAfterSend(shouldDelete = true): this {
    this.shouldDeleteAfterSend = shouldDelete;

    return this;
  }

  override async toWeb(): Promise<WebResponse> {
    // Streaming sources are piped straight through, never buffered, so a
    // multi-gigabyte download costs no heap. `Content-Length` is not known
    // here, so it is left to the caller to set (or omitted for chunked).
    const stream = this.asStream();

    if (stream !== null) {
      const headers = new Headers(this.headers);

      if (!headers.has("Content-Type")) {
        headers.set("Content-Type", this.explicitContentType ?? "application/octet-stream");
      }

      return new WebResponse(stream, { status: this.statusCode, headers });
    }

    const { bytes, contentType } = await this.readSource();

    const headers = new Headers(this.headers);

    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", this.explicitContentType ?? contentType);
    }

    headers.set("Content-Length", String(bytes.byteLength));

    if (this.shouldDeleteAfterSend && typeof this.source === "string") {
      // Buffered read is complete; fire-and-forget the unlink. Swallow
      // errors (file may already be gone). Deletion is best-effort.
      void unlink(this.source).catch(() => {});
    }

    return new WebResponse(bytes, { status: this.statusCode, headers });
  }

  /** The source as a web `ReadableStream` if it is a stream, else `null`. */
  private asStream(): ReadableStream<Uint8Array> | null {
    const source = this.source;

    if (source instanceof Readable) {
      return Readable.toWeb(source) as unknown as ReadableStream<Uint8Array>;
    }

    if (typeof (source as ReadableStream<Uint8Array>).getReader === "function") {
      return source as ReadableStream<Uint8Array>;
    }

    return null;
  }

  private async readSource(): Promise<{ bytes: Uint8Array; contentType: string }> {
    const source = this.source as string | File | Blob | Uint8Array;

    if (typeof source === "string") {
      const buf = await readFile(source);

      return { bytes: new Uint8Array(buf), contentType: mimeTypeForPath(source) };
    }

    if (source instanceof Uint8Array) {
      return { bytes: source, contentType: "application/octet-stream" };
    }

    // File / Blob (Web-standard, what Request parses inbound).
    const buf = new Uint8Array(await source.arrayBuffer());
    const type = source.type && source.type !== "" ? source.type : "application/octet-stream";

    return { bytes: buf, contentType: type };
  }

  private defaultFilename(): string | undefined {
    const source = this.source;

    if (typeof source === "string") {
      return basename(source);
    }

    if (source instanceof File) {
      return source.name;
    }

    return undefined;
  }
}
