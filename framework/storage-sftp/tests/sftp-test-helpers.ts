import { randomBytes } from "node:crypto";
import { Client } from "ssh2";
import { SftpStorageDriver } from "../src/sftp-storage-driver.js";
import type { SftpConnectionConfig } from "../src/sftp-connection.js";

/**
 * These tests talk to a real SSH server (`atmoz/sftp` in the repo root's
 * `docker-compose.yml`). Nothing in-process substitutes for it: atomic
 * replace depends on the server advertising
 * `posix-rename@openssh.com`, plain `rename` refusing an existing target
 * is the server's rule, recursive `mkdir`/`rmdir` limitations are the
 * protocol's, and "the session was dropped between two calls" cannot be
 * tested against a mock that never had a session. A fake here would
 * assert that the driver calls the functions the fake was written
 * around.
 *
 * With no server reachable the suites self-skip via `describe.skipIf`,
 * except under `CI_STRICT_MODE=true`, where they **fail** instead. Same
 * reasoning as the Redis suites: a silent skip on CI reports green while
 * testing nothing, and the code most in need of these tests is exactly
 * the code that only a real server exercises.
 */

const SFTP_HOST = process.env.SFTP_HOST ?? "127.0.0.1";
const SFTP_PORT = Number(process.env.SFTP_PORT ?? 2222);
const SFTP_USERNAME = process.env.SFTP_USERNAME ?? "mahi";
const SFTP_PASSWORD = process.env.SFTP_PASSWORD ?? "mahi";

/**
 * `atmoz/sftp` chroots the account to its home, which is root-owned so
 * that the chroot is valid; `upload` is the writable subdirectory inside
 * it. Every test disk is rooted somewhere under here.
 */
const WRITABLE_BASE = process.env.SFTP_BASE ?? "upload";

export function sftpConfig(overrides: Partial<SftpConnectionConfig> = {}): SftpConnectionConfig {
  return {
    host: SFTP_HOST,
    port: SFTP_PORT,
    username: SFTP_USERNAME,
    password: SFTP_PASSWORD,
    ...overrides,
  };
}

/** True if an SSH server completed a handshake and gave us an SFTP channel. */
export async function sftpAvailable(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const client = new Client();
    let settled = false;
    const done = (result: boolean): void => {
      if (settled) {
        return;
      }

      settled = true;
      client.removeAllListeners();
      client.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => done(false), 4_000);
    timer.unref();

    client.once("error", () => done(false));
    client.once("ready", () => {
      client.sftp((error) => done(!error));
    });

    client.connect({
      host: SFTP_HOST,
      port: SFTP_PORT,
      username: SFTP_USERNAME,
      password: SFTP_PASSWORD,
      readyTimeout: 4_000,
    });
  });
}

/**
 * Vitest evaluates `describe.skipIf(condition)` synchronously, so it
 * can't await the probe. This runs once at module load and the result is
 * reused for the whole file.
 */
const available = await sftpAvailable();

// Keyed off `CI_STRICT_MODE`, not `CI`: GitHub Actions sets `CI` on every
// runner, including the service-free job that is supposed to skip these.
if (!available && process.env.CI_STRICT_MODE === "true") {
  throw new Error(
    `No SFTP server at ${SFTP_HOST}:${SFTP_PORT}. The @mahiframework/storage-sftp integration ` +
      "tests must run where services are provisioned, or set SFTP_HOST/SFTP_PORT.",
  );
}

export const SFTP_UNAVAILABLE = !available;

/** A remote directory unique to one test, so suites never collide. */
export function testRoot(): string {
  return `${WRITABLE_BASE}/mahi-test-${randomBytes(6).toString("hex")}`;
}

/**
 * A driver on a freshly created, empty remote directory, plus the cleanup
 * that removes it. Every contract case assumes an empty disk.
 */
export async function testDriver(
  overrides: Partial<SftpConnectionConfig> = {},
  urlPrefix?: string,
): Promise<{ driver: SftpStorageDriver; root: string; cleanup: () => Promise<void> }> {
  const root = overrides.root ?? testRoot();
  const driver = new SftpStorageDriver(sftpConfig({ ...overrides, root }), urlPrefix);
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
