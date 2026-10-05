import { createDeflateRaw, crc32 } from "node:zlib";
import { Readable, Transform, pipeline } from "node:stream";

/** One file to put in the archive. */
export interface ZipEntry {
  /** The path inside the archive. Forward slashes, no leading slash. */
  name: string;
  /** Opened lazily, so only one file's bytes are in flight at a time. */
  open: () => Promise<Readable>;
  /** Last-modified time, written into the entry header. */
  modified?: Date;
}

/**
 * A ZIP archive, written as a stream.
 *
 * NOTHING IS BUFFERED. Each entry's bytes are read, deflated and emitted
 * in chunks, and only the central directory — a few dozen bytes per
 * entry — is held in memory. A 50GB archive of a thousand files costs
 * the same heap as a 1MB one.
 *
 * That is the whole reason this is hand-rolled rather than a dependency.
 * laravel-media's zip downloader materialises the entire archive to a
 * temp file inside what it calls a streamed response, and loads every
 * member fully into memory with `addFromString` on the way. For a
 * gallery download that is the difference between working and an OOM.
 *
 * ZIP64 ALWAYS. The format's original fields are 32-bit, so sizes above
 * 4GiB and archives of more than 65535 entries need the Zip64
 * extensions. Emitting them unconditionally costs 20 bytes per entry and
 * removes an entire class of "it worked until the archive got big" bug.
 *
 * Deflate is streamed per entry, and sizes and CRCs are therefore
 * unknown when the local header is written — so every entry uses a data
 * descriptor (bit 3 of the general-purpose flags), which is exactly what
 * that flag is for.
 */
export function zipStream(entries: readonly ZipEntry[]): Readable {
  return Readable.from(generate(entries));
}

const LOCAL_HEADER = 0x04034b50;
const DATA_DESCRIPTOR = 0x08074b50;
const CENTRAL_HEADER = 0x02014b50;
const CENTRAL_END = 0x06054b50;
const ZIP64_END = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;

/** Deflate, and the version needed to extract a Zip64 entry. */
const METHOD_DEFLATE = 8;
const VERSION_ZIP64 = 45;

/** Bit 3: sizes and CRC follow the data in a descriptor. Bit 11: UTF-8 names. */
const FLAG_DATA_DESCRIPTOR = 0x08;
const FLAG_UTF8 = 0x0800;

/** What the central directory needs to remember about one written entry. */
interface WrittenEntry {
  name: Buffer;
  crc: number;
  compressed: bigint;
  uncompressed: bigint;
  offset: bigint;
  dosTime: number;
  dosDate: number;
}

async function* generate(entries: readonly ZipEntry[]): AsyncGenerator<Buffer> {
  const written: WrittenEntry[] = [];
  const used = new Set<string>();

  let offset = 0n;

  for (const entry of entries) {
    const name = Buffer.from(uniqueName(entry.name, used), "utf8");
    const { dosTime, dosDate } = dosTimestamp(entry.modified ?? new Date());

    // The entry's own offset is where its LOCAL HEADER starts, captured
    // before anything for it is emitted. Deriving it afterwards by
    // adding up field widths is how an off-by-one makes `unzip` report
    // "bad zipfile offset (local header sig)".
    const entryOffset = offset;
    const header = localHeader(name, dosTime, dosDate);

    yield header;
    offset += BigInt(header.byteLength);

    let crc = 0;
    let uncompressed = 0n;
    let compressed = 0n;

    const source = await entry.open();
    const deflate = createDeflateRaw();

    // Hash and count the plain bytes on the way in; count the deflated
    // bytes on the way out. Both have to be known before the data
    // descriptor, which is why it follows the data rather than preceding
    // it.
    //
    // Measure on the way in, deflate, measure on the way out. Both the
    // CRC and the plain size have to be known before the data
    // descriptor, which is why that record follows the data.
    //
    // A TRANSFORM rather than a `data` listener. A listener cannot
    // reject this generator — an exception thrown inside one surfaces as
    // an uncaught exception on the stream and takes the process down —
    // and `pipe()` would feed the bad chunk straight into zlib anyway.
    // A transform's error propagates through the pipeline, which turns a
    // malformed source into a failed download.
    const measure = new Transform({
      transform(chunk: unknown, _encoding, done) {
        let buffer: Buffer;

        try {
          buffer = toBuffer(chunk);
        } catch (error) {
          done(error instanceof Error ? error : new Error(String(error)));

          return;
        }

        crc = crc32(buffer, crc);
        uncompressed += BigInt(buffer.byteLength);

        done(null, buffer);
      },
    });

    // Errors anywhere in the chain surface on the final stream, so the
    // `for await` below rejects rather than leaving a dangling handler.
    const compressing = pipeline(source, measure, deflate, () => {});

    for await (const chunk of compressing) {
      const buffer = toBuffer(chunk);

      compressed += BigInt(buffer.byteLength);

      yield buffer;
    }

    const descriptor = dataDescriptor(crc, compressed, uncompressed);

    yield descriptor;

    written.push({
      name,
      crc,
      compressed,
      uncompressed,
      offset: entryOffset,
      dosTime,
      dosDate,
    });

    offset += compressed + BigInt(descriptor.byteLength);
  }

  // The central directory: one record per entry, then the end records
  // that tell a reader where the directory starts.
  const directoryOffset = offset;
  let directorySize = 0n;

  for (const entry of written) {
    const record = centralRecord(entry);

    directorySize += BigInt(record.byteLength);

    yield record;
  }

  yield zip64EndRecord(written.length, directorySize, directoryOffset);
  yield zip64Locator(directoryOffset + directorySize);
  yield endRecord(written.length);
}

/** Normalise a stream chunk to a `Buffer`, whatever mode produced it. */
function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }

  if (typeof chunk === "string") {
    return Buffer.from(chunk, "utf8");
  }

  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }

  throw new TypeError(
    `A zip entry's stream yielded a ${typeof chunk}, which is not bytes. An entry's ` +
      `\`open()\` must return a stream of Buffers, strings or Uint8Arrays.`,
  );
}

function localHeader(name: Buffer, dosTime: number, dosDate: number): Buffer {
  const extra = zip64ExtraField(0n, 0n);
  const header = Buffer.alloc(30);

  header.writeUInt32LE(LOCAL_HEADER, 0);
  header.writeUInt16LE(VERSION_ZIP64, 4);
  header.writeUInt16LE(FLAG_DATA_DESCRIPTOR | FLAG_UTF8, 6);
  header.writeUInt16LE(METHOD_DEFLATE, 8);
  header.writeUInt16LE(dosTime, 10);
  header.writeUInt16LE(dosDate, 12);
  // CRC and both sizes are zero here and carried in the data descriptor,
  // which is what the data-descriptor flag promises a reader.
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(0, 18);
  header.writeUInt32LE(0, 22);
  header.writeUInt16LE(name.byteLength, 26);
  header.writeUInt16LE(extra.byteLength, 28);

  return Buffer.concat([header, name, extra]);
}

/** The post-data record carrying the CRC and sizes, in Zip64 widths. */
function dataDescriptor(crc: number, compressed: bigint, uncompressed: bigint): Buffer {
  const descriptor = Buffer.alloc(24);

  descriptor.writeUInt32LE(DATA_DESCRIPTOR, 0);
  descriptor.writeUInt32LE(crc >>> 0, 4);
  descriptor.writeBigUInt64LE(compressed, 8);
  descriptor.writeBigUInt64LE(uncompressed, 16);

  return descriptor;
}

function centralRecord(entry: WrittenEntry): Buffer {
  const extra = zip64ExtraField(entry.uncompressed, entry.compressed, entry.offset);
  const record = Buffer.alloc(46);

  record.writeUInt32LE(CENTRAL_HEADER, 0);
  // "Made by" a Unix system, so permissions in the external attributes
  // are read as such rather than as DOS attributes.
  record.writeUInt16LE((3 << 8) | VERSION_ZIP64, 4);
  record.writeUInt16LE(VERSION_ZIP64, 6);
  record.writeUInt16LE(FLAG_DATA_DESCRIPTOR | FLAG_UTF8, 8);
  record.writeUInt16LE(METHOD_DEFLATE, 10);
  record.writeUInt16LE(entry.dosTime, 12);
  record.writeUInt16LE(entry.dosDate, 14);
  record.writeUInt32LE(entry.crc >>> 0, 16);
  // The 32-bit fields are saturated and the real values live in the
  // Zip64 extra field.
  record.writeUInt32LE(0xffffffff, 20);
  record.writeUInt32LE(0xffffffff, 24);
  record.writeUInt16LE(entry.name.byteLength, 28);
  record.writeUInt16LE(extra.byteLength, 30);
  // No comment, disk 0, no internal attributes.
  record.writeUInt16LE(0, 32);
  record.writeUInt16LE(0, 34);
  record.writeUInt16LE(0, 36);
  // External attributes: 0644, as a regular file, in the high 16 bits.
  record.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  // Saturated; the real offset is in the Zip64 extra field.
  record.writeUInt32LE(0xffffffff, 42);

  return Buffer.concat([record, entry.name, extra]);
}

/**
 * The Zip64 extra field.
 *
 * In a local header both sizes are unknown, so zeros are written and the
 * field exists only to reserve the space. In a central record it carries
 * the real sizes and the entry's offset.
 */
function zip64ExtraField(uncompressed: bigint, compressed: bigint, offset?: bigint): Buffer {
  const size = offset === undefined ? 16 : 24;
  const field = Buffer.alloc(4 + size);

  field.writeUInt16LE(0x0001, 0);
  field.writeUInt16LE(size, 2);
  field.writeBigUInt64LE(uncompressed, 4);
  field.writeBigUInt64LE(compressed, 12);

  if (offset !== undefined) {
    field.writeBigUInt64LE(offset, 20);
  }

  return field;
}

function zip64EndRecord(count: number, size: bigint, offset: bigint): Buffer {
  const record = Buffer.alloc(56);

  record.writeUInt32LE(ZIP64_END, 0);
  // Size of this record minus the signature and this field.
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE((3 << 8) | VERSION_ZIP64, 12);
  record.writeUInt16LE(VERSION_ZIP64, 14);
  record.writeUInt32LE(0, 16);
  record.writeUInt32LE(0, 20);
  record.writeBigUInt64LE(BigInt(count), 24);
  record.writeBigUInt64LE(BigInt(count), 32);
  record.writeBigUInt64LE(size, 40);
  record.writeBigUInt64LE(offset, 48);

  return record;
}

function zip64Locator(offset: bigint): Buffer {
  const locator = Buffer.alloc(20);

  locator.writeUInt32LE(ZIP64_LOCATOR, 0);
  locator.writeUInt32LE(0, 4);
  locator.writeBigUInt64LE(offset, 8);
  locator.writeUInt32LE(1, 16);

  return locator;
}

/**
 * The classic end-of-central-directory record.
 *
 * Still written, with its 32-bit fields saturated, because a reader that
 * does not understand Zip64 looks for this signature to find the
 * directory at all — and one that does understand it finds the Zip64
 * locator immediately before.
 */
function endRecord(count: number): Buffer {
  const record = Buffer.alloc(22);
  const entries = count > 0xffff ? 0xffff : count;

  record.writeUInt32LE(CENTRAL_END, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(entries, 8);
  record.writeUInt16LE(entries, 10);
  record.writeUInt32LE(0xffffffff, 12);
  record.writeUInt32LE(0xffffffff, 16);
  record.writeUInt16LE(0, 20);

  return record;
}

/**
 * DOS date and time, which is what a ZIP entry header carries.
 *
 * Two-second resolution and an epoch of 1980 — a limitation of the
 * format, not of this code. Dates before 1980 are clamped, because the
 * fields cannot represent them and a negative year would produce an
 * archive some readers reject outright.
 */
function dosTimestamp(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getFullYear());

  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Make `name` unique within the archive, as `name-2.ext`.
 *
 * Two media rows can legitimately share an `original_filename` — two
 * people uploading `photo.jpg` — and a ZIP with duplicate entries
 * extracts to one file, silently losing the others.
 */
export function uniqueName(name: string, used: Set<string>): string {
  const safe = name.replace(/^\/+/, "").replace(/\\/g, "/");

  if (!used.has(safe)) {
    used.add(safe);

    return safe;
  }

  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const extension = dot > 0 ? safe.slice(dot) : "";

  for (let suffix = 2; ; suffix++) {
    const candidate = `${stem}-${suffix}${extension}`;

    if (!used.has(candidate)) {
      used.add(candidate);

      return candidate;
    }
  }
}
