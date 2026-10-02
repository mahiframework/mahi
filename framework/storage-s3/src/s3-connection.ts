import type { Readable } from "node:stream";
import type {
  CompletedPart,
  GetObjectCommandOutput,
  HeadObjectCommandOutput,
  S3Client,
  S3ClientConfig,
} from "@aws-sdk/client-s3";

export interface S3ConnectionConfig {
  bucket: string;
  /**
   * Defaults to `us-east-1`. Meaningless to most S3-compatible servers,
   * but the SDK refuses to sign a request without one.
   */
  region?: string;
  /**
   * Omitted for AWS. Set it for R2, Spaces, MinIO, Supabase, rustfs, and
   * anything else speaking the protocol at its own address.
   */
  endpoint?: string;
  /**
   * Put the bucket in the path rather than the hostname. AWS prefers
   * virtual-hosted style and most self-hosted servers only do path style,
   * so this defaults to `true` whenever `endpoint` is set.
   */
  forcePathStyle?: boolean;
  /**
   * Omitted, the SDK's own credential chain applies: environment
   * variables, shared config, SSO, IMDS on EC2, the projected token on
   * EKS. That chain is the right answer anywhere with an instance role,
   * so this is deliberately optional rather than required.
   */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /** Key prefix, so one bucket can back several disks. */
  root?: string;
  /**
   * Multipart part size in bytes. Defaults to 5 MiB, which is also S3's
   * minimum for every part but the last.
   */
  partSize?: number;
  /** Parts uploaded concurrently within one object. Defaults to 4. */
  queueSize?: number;
  /** Keys fetched per listing request. Defaults to 1000, S3's maximum. */
  pageSize?: number;
}

/** S3's minimum part size for all but the final part of a multipart upload. */
const MINIMUM_PART_SIZE = 5 * 1024 * 1024;

/**
 * The bucket handle: one `S3Client`, the SDK loaded lazily, and the
 * protocol's quirks kept in one place.
 *
 * Unlike `SftpConnection` there is no session to open, no handshake to
 * amortise and no reconnect logic. An `S3Client` is a signer in front of
 * a pooled HTTPS agent, and the SDK already retries idempotent requests
 * itself. What this type is actually for is the lazy `import`, the
 * root-prefix arithmetic, and classifying the two different shapes S3
 * uses to say "no such key".
 */
export class S3Connection {
  private client?: S3Client;
  /** In-flight load, so concurrent first calls share one dynamic import. */
  private loading?: Promise<S3Client>;
  private sdk?: typeof import("@aws-sdk/client-s3");

  constructor(private readonly config: S3ConnectionConfig) {}

  bucket(): string {
    return this.config.bucket;
  }

  partSize(): number {
    return Math.max(this.config.partSize ?? MINIMUM_PART_SIZE, MINIMUM_PART_SIZE);
  }

  queueSize(): number {
    return Math.max(this.config.queueSize ?? 4, 1);
  }

  pageSize(): number {
    return Math.min(Math.max(this.config.pageSize ?? 1000, 1), 1000);
  }

  /** The configured key prefix, normalized without leading or trailing slashes. */
  root(): string {
    return (this.config.root ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
  }

  /** The absolute object key for a disk-relative path. */
  key(relative: string): string {
    const root = this.root();

    if (relative === "") {
      return root === "" ? "" : `${root}/`;
    }

    return root === "" ? relative : `${root}/${relative}`;
  }

  /** The disk-relative path for an absolute object key, or `undefined` if outside the root. */
  relative(key: string): string | undefined {
    const root = this.root();

    if (root === "") {
      return key;
    }

    if (!key.startsWith(`${root}/`)) {
      return undefined;
    }

    return key.slice(root.length + 1);
  }

  /** Whether this disk is already connected, i.e. the SDK has been loaded. */
  connected(): boolean {
    return this.client !== undefined;
  }

  /** Load the SDK and build the client. Idempotent. */
  async connect(): Promise<S3Client> {
    if (this.client !== undefined) {
      return this.client;
    }

    this.loading ??= this.open().finally(() => {
      this.loading = undefined;
    });

    return this.loading;
  }

  /**
   * Release the client's sockets. There is no session to tear down, but
   * the agent holds keep-alive connections that outlive a `forget()`
   * otherwise. Deliberately not `Connectable`: see the class comment on
   * `S3StorageDriver`.
   */
  async disconnect(): Promise<void> {
    this.client?.destroy();
    this.client = undefined;
  }

  /** The loaded SDK namespace, for building commands. */
  async commands(): Promise<typeof import("@aws-sdk/client-s3")> {
    await this.connect();

    return this.sdk as typeof import("@aws-sdk/client-s3");
  }

  /** Run one operation against the client. */
  async run<T>(operation: (client: S3Client) => Promise<T>): Promise<T> {
    return operation(await this.connect());
  }

  private async open(): Promise<S3Client> {
    const sdk = await loadS3Sdk();
    this.sdk = sdk;

    const options: S3ClientConfig = {
      region: this.config.region ?? "us-east-1",
    };

    if (this.config.endpoint !== undefined) {
      options.endpoint = this.config.endpoint;
      // Self-hosted servers generally cannot do virtual-hosted style,
      // where the bucket is a hostname label, so a custom endpoint
      // implies path style unless told otherwise.
      options.forcePathStyle = this.config.forcePathStyle ?? true;
    } else if (this.config.forcePathStyle !== undefined) {
      options.forcePathStyle = this.config.forcePathStyle;
    }

    if (this.config.credentials !== undefined) {
      options.credentials = this.config.credentials;
    }

    this.client = new sdk.S3Client(options);

    return this.client;
  }

  /** `HeadObject`, with a missing key reported as `undefined` rather than thrown. */
  async head(key: string): Promise<HeadObjectCommandOutput | undefined> {
    const sdk = await this.commands();

    try {
      return await this.run((client) =>
        client.send(new sdk.HeadObjectCommand({ Bucket: this.config.bucket, Key: key })),
      );
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }

      throw error;
    }
  }

  /** `GetObject`, with a missing key reported as `undefined`. */
  async getObject(key: string, range?: string): Promise<GetObjectCommandOutput | undefined> {
    const sdk = await this.commands();

    try {
      return await this.run((client) =>
        client.send(
          new sdk.GetObjectCommand({ Bucket: this.config.bucket, Key: key, Range: range }),
        ),
      );
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }

      throw error;
    }
  }
}

/**
 * Whether an SDK error means "that key isn't there".
 *
 * Two different shapes, which is the trap: `GetObject` reports `NoSuchKey`
 * and `HeadObject` reports `NotFound`, because a HEAD response has no body
 * to carry the real error code in. Matching the 404 as well as the names
 * covers S3-compatible servers that use neither spelling.
 */
export function isNotFound(error: unknown): boolean {
  const candidate = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };

  if (candidate?.$metadata?.httpStatusCode === 404) {
    return true;
  }

  const name = candidate?.name ?? candidate?.Code;

  return name === "NoSuchKey" || name === "NotFound" || name === "NoSuchBucket";
}

/**
 * Load `@aws-sdk/client-s3` on first use.
 *
 * It is an optional peer dependency — 18 MB and 27 packages — so an
 * application with no S3 disk never installs it, and one with a
 * registered-but-unused S3 disk never loads it.
 */
async function loadS3Sdk(): Promise<typeof import("@aws-sdk/client-s3")> {
  try {
    return await import("@aws-sdk/client-s3");
  } catch (error) {
    throw new Error(
      "The s3 storage driver needs the `@aws-sdk/client-s3` package, which is an optional peer " +
        "dependency of @mahiframework/storage-s3. Install it: " +
        "`npm install @aws-sdk/client-s3 @aws-sdk/lib-storage`.",
      { cause: error },
    );
  }
}

/** Load `@aws-sdk/lib-storage`, which owns the multipart upload machinery. */
export async function loadUpload(): Promise<typeof import("@aws-sdk/lib-storage")> {
  try {
    return await import("@aws-sdk/lib-storage");
  } catch (error) {
    throw new Error(
      "Writing to an s3 disk needs the `@aws-sdk/lib-storage` package, which is an optional peer " +
        "dependency of @mahiframework/storage-s3. Install it: `npm install @aws-sdk/lib-storage`.",
      { cause: error },
    );
  }
}

/** Load `@aws-sdk/s3-request-presigner`, only needed for `temporaryUrl()`. */
export async function loadPresigner(): Promise<typeof import("@aws-sdk/s3-request-presigner")> {
  try {
    return await import("@aws-sdk/s3-request-presigner");
  } catch (error) {
    throw new Error(
      "temporaryUrl() needs the `@aws-sdk/s3-request-presigner` package, which is an optional " +
        "peer dependency of @mahiframework/storage-s3. Install it: " +
        "`npm install @aws-sdk/s3-request-presigner`.",
      { cause: error },
    );
  }
}

/** Type-only re-exports, so consumers needn't import the SDK for signatures. */
export type { CompletedPart, Readable, S3Client };
