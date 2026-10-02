import { randomBytes } from "node:crypto";
import { FtpStorageDriver } from "../src/ftp-storage-driver.js";
import type { FtpConnectionConfig } from "../src/ftp-connection.js";

/**
 * These tests talk to a real FTP server (`delfer/alpine-ftp-server` in the
 * repo root's `docker-compose.yml`). Nothing in-process substitutes for
 * it, and FTP's quirks are especially invisible from the type definitions:
 * the client allowing only one command at a time, `LIST` returning a date
 * with no year, `STOR` refusing to create parent directories, `REST`
 * offering a start offset and no end, whether a rename will clobber an
 * existing target, and passive-mode data connections. A fake would assert
 * that the driver calls the functions the fake was written around.
 *
 * With no server reachable the suites self-skip via `describe.skipIf`,
 * except under `CI_STRICT_MODE=true`, where they **fail** instead: a silent
 * skip on CI reports green while testing nothing.
 */

const FTP_HOST = process.env.FTP_HOST ?? "127.0.0.1";
const FTP_PORT = Number(process.env.FTP_PORT ?? 2121);
const FTP_USER = process.env.FTP_USER ?? "mahi";
// Long enough to survive the image's own `adduser` password check, which
// rejects a short one and still starts, leaving an account that only fails
// at login.
const FTP_PASSWORD = process.env.FTP_PASSWORD ?? "mahipass123";

export function ftpConfig(overrides: Partial<FtpConnectionConfig> = {}): FtpConnectionConfig {
  return {
    host: FTP_HOST,
    port: FTP_PORT,
    user: FTP_USER,
    password: FTP_PASSWORD,
    ...overrides,
  };
}

/** True if an FTP server accepted a login and a `FEAT`. */
export async function ftpAvailable(): Promise<boolean> {
  try {
    const { Client } = await import("basic-ftp");
    const client = new Client(4_000);

    try {
      await client.access({
        host: FTP_HOST,
        port: FTP_PORT,
        user: FTP_USER,
        password: FTP_PASSWORD,
        secure: false,
      });
      await client.features();

      return true;
    } finally {
      client.close();
    }
  } catch {
    return false;
  }
}

/**
 * Vitest evaluates `describe.skipIf(condition)` synchronously, so it can't
 * await the probe. This runs once at module load and is reused for the
 * whole file.
 */
const available = await ftpAvailable();

// Keyed off `CI_STRICT_MODE`, not `CI`: GitHub Actions sets `CI` on every
// runner, including the service-free job that is supposed to skip these.
if (!available && process.env.CI_STRICT_MODE === "true") {
  throw new Error(
    `No FTP server at ${FTP_HOST}:${FTP_PORT}. The @mahiframework/storage-ftp integration ` +
      "tests must run where services are provisioned, or set FTP_HOST/FTP_PORT.",
  );
}

export const FTP_UNAVAILABLE = !available;

/** A remote directory unique to one test, so suites never collide. */
export function testRoot(): string {
  return `mahi-test-${randomBytes(6).toString("hex")}`;
}

/**
 * A driver on a freshly created, empty remote directory, plus the cleanup
 * that removes it. Every contract case assumes an empty disk.
 */
export async function testDriver(
  overrides: Partial<FtpConnectionConfig> = {},
  urlPrefix?: string,
): Promise<{ driver: FtpStorageDriver; root: string; cleanup: () => Promise<void> }> {
  const root = overrides.root ?? testRoot();
  const driver = new FtpStorageDriver(ftpConfig({ ...overrides, root }), urlPrefix);
  await driver.makeDirectory("");

  return {
    driver,
    root,
    cleanup: async () => {
      await driver.deleteDirectory("").catch(() => {});
      await driver.disconnect();
    },
  };
}
