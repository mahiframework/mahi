import { attachedText, type FetchBody } from "./client-request.js";
import { encodeNested } from "./query-encoder.js";

/**
 * What `attach()` accepts as a file's bytes.
 *
 * `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`, whose default
 * type argument is `ArrayBufferLike` and therefore also admits a
 * `SharedArrayBuffer`-backed view. `Blob`/`File` cannot take one — their
 * `BufferSource` is `NonSharedArrayBufferView | ArrayBuffer` — so the wider
 * type was never actually constructible here. Naming it narrowly reports
 * the mistake at the `attach()` call instead of inside the body builder.
 * `Buffer` satisfies it, which is what callers pass in practice.
 */
export type AttachmentContents =
  Blob | Uint8Array<ArrayBuffer> | string | ReadableStream<Uint8Array>;

/** A single `attach()` call, held until the body is built at send time. */
export interface Attachment {
  name: string;
  contents: AttachmentContents;
  filename?: string;
  headers?: Record<string, string>;
}

/**
 * Builds the `FormData` body for a multipart request from the regular
 * fields plus any `attach()`ed files.
 *
 * We never set `Content-Type` ourselves: `fetch` generates it from the
 * `FormData`, including the boundary, and a hand-written one without a
 * matching boundary produces a request no server can parse.
 */
export async function buildMultipart(
  data: unknown,
  attachments: readonly Attachment[],
): Promise<FormData> {
  const form = new FormData();

  if (data !== null && data !== undefined && typeof data === "object" && !Array.isArray(data)) {
    // Bracket-nesting so `{ a: { b: 1 } }` becomes the field `a[b]=1`
    // rather than `a=[object Object]`.
    for (const [key, value] of encodeNested(data as Record<string, unknown>)) {
      form.append(key, value);
    }
  }

  for (const attachment of attachments) {
    // Appended without the third `filename` argument on purpose: passing
    // one makes `FormData` re-wrap the value into a *new* `File`, which
    // would discard the `attachedText` entry `hasFile(name, contents)`
    // relies on. `toFilePart` has already set the filename on the File.
    form.append(attachment.name, await toFilePart(attachment));
  }

  return form;
}

/**
 * Normalises attachment contents into a `File`, recording its text in
 * `attachedText` so `ClientRequest.hasFile(name, contents)` can compare
 * synchronously. `File.text()` is async, and assertion callbacks are not.
 *
 * A `ReadableStream` is drained here: `FormData` has no streaming part, so
 * a streamed attachment has to be materialised regardless. Streaming a
 * large upload is `withBody(stream)`, not `attach()`.
 */
async function toFilePart(attachment: Attachment): Promise<File> {
  const { contents, filename, headers } = attachment;
  const type = headers?.["Content-Type"] ?? headers?.["content-type"];

  let blob: Blob;

  if (contents instanceof Blob) {
    blob = type ? new Blob([await contents.arrayBuffer()], { type }) : contents;
  } else if (contents instanceof ReadableStream) {
    blob = await new Response(contents as FetchBody).blob();

    if (type) {
      blob = new Blob([await blob.arrayBuffer()], { type });
    }
  } else if (typeof contents === "string") {
    blob = new Blob([contents], { type: type ?? "" });
  } else {
    blob = new Blob([contents], { type: type ?? "" });
  }

  const file = new File(
    [blob],
    filename ?? attachment.name,
    blob.type ? { type: blob.type } : undefined,
  );

  // Only cache text for contents that were textual to begin with; decoding
  // arbitrary binary to compare against a string is meaningless.
  if (typeof contents === "string") {
    attachedText.set(file, contents);
  } else {
    attachedText.set(file, await file.text());
  }

  return file;
}
