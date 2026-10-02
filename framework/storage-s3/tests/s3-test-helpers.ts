import { randomBytes } from "node:crypto";
import { S3StorageDriver } from "../src/s3-storage-driver.js";
import type { S3ConnectionConfig } from "../src/s3-connection.js";

/**
 * These tests talk to a real S3 server (`rustfs` in the repo root's
 * `docker-compose.yml`). Nothing in-process substitutes for it: a
 * multipart upload staying invisible until it completes is what the
 * driver's write atomicity rests on, `CommonPrefixes` under a delimiter is
 * how directories are reported at all, the continuation token on a
 * truncated listing is the server's pagination, and `CopyObject` moving
 * bytes without them reaching this process is the whole point of
 * `copy()`. A fake would assert that the driver calls the functions the
 * fake was written around.
 *
 * With no server reachable the suites self-skip via `describe.skipIf`,
 * except under `CI_STRICT_MODE=true`, where they **fail** instead: a
 * silent skip on CI reports green while testing nothing.
 */

// 9400, not S3's conventional 9000: php-fpm defaults to 9000 too, and on a
// host already running it Docker's bind loses every connection, which
// presents as a broken driver rather than a port conflict.
const S3_ENDPOINT = process.env.S3_ENDPOINT ?? "http://127.0.0.1:9400";
const S3_BUCKET = process.env.S3_BUCKET ?? "mahi-test";
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY ?? "mahi";
const S3_SECRET_KEY = process.env.S3_SECRET_KEY ?? "mahi-secret";
const S3_REGION = process.env.S3_REGION ?? "us-east-1";

export function s3Config(overrides: Partial<S3ConnectionConfig> = {}): S3ConnectionConfig {
  return {
    bucket: S3_BUCKET,
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
    ...overrides,
  };
}

/**
 * True if the bucket is reachable and signing works.
 *
 * A `HeadBucket` rather than the health endpoint: it proves the
 * credentials sign correctly and the bucket exists, which is what the
 * suites actually need. A server that is up but has no bucket would
 * otherwise fail every test one at a time.
 */
export async function s3Available(): Promise<boolean> {
  try {
    const { S3Client, HeadBucketCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({
      endpoint: S3_ENDPOINT,
      region: S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
      requestHandler: { requestTimeout: 4_000, connectionTimeout: 4_000 },
    });

    await client.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
    client.destroy();

    return true;
  } catch {
    return false;
  }
}

/**
 * Vitest evaluates `describe.skipIf(condition)` synchronously, so it can't
 * await the probe. This runs once at module load and is reused for the
 * whole file.
 */
const available = await s3Available();

// Keyed off `CI_STRICT_MODE`, not `CI`: GitHub Actions sets `CI` on every
// runner, including the service-free job that is supposed to skip these.
if (!available && process.env.CI_STRICT_MODE === "true") {
  throw new Error(
    `No S3 bucket [${S3_BUCKET}] at ${S3_ENDPOINT}. The @mahiframework/storage-s3 integration ` +
      "tests must run where services are provisioned, or set S3_ENDPOINT/S3_BUCKET.",
  );
}

export const S3_UNAVAILABLE = !available;

/**
 * A key prefix unique to one test.
 *
 * A prefix rather than a bucket per suite: bucket creation is slow, and
 * several providers rate-limit it hard enough to make a per-suite bucket
 * the slowest part of the run.
 */
export function testRoot(): string {
  return `mahi-test-${randomBytes(6).toString("hex")}`;
}

/**
 * A driver rooted at an unused key prefix, plus the cleanup that empties
 * it. Every contract case assumes an empty disk.
 */
export async function testDriver(
  overrides: Partial<S3ConnectionConfig> = {},
  urlPrefix?: string,
): Promise<{ driver: S3StorageDriver; root: string; cleanup: () => Promise<void> }> {
  const root = overrides.root ?? testRoot();
  const driver = new S3StorageDriver(s3Config({ ...overrides, root }), urlPrefix);

  return {
    driver,
    root,
    cleanup: async () => {
      await driver.deleteDirectory("").catch(() => {});
      await driver.disconnect();
    },
  };
}
