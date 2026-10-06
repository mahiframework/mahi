import path from "node:path";
import type { Client, ConnectConfig, SFTPWrapper, Stats } from "ssh2";

/**
 * Everything needed to reach one SFTP host, plus the disk's root on it.
 *
 * `root` is resolved against the login user's home directory when
 * relative, so `"media"` and `"/srv/media"` are both valid, and it does
 * not have to exist yet: writes create it, and listing a root that isn't
 * there yields `[]` like any other missing directory.
 */
export interface SftpConnectionConfig {
  host: string;
  port?: number;
  username: string;
  password?: string;
  /** OpenSSH-format private key, the contents rather than a path to them. */
  privateKey?: string | Buffer;
  passphrase?: string;
  root?: string;
  /**
   * SSH-level keepalive interval in ms, `0` disables. Defaults to 20s,
   * which keeps a NAT or an idle-timing-out appliance from silently
   * dropping the session between two infrequent operations. A drop that
   * happens anyway is recovered by the reconnect-once path, this just
   * makes it rarer.
   */
  keepaliveInterval?: number;
  /** Handshake timeout in ms. Defaults to 20s. */
  readyTimeout?: number;
  /**
   * Maximum concurrent SFTP requests the recursive walks issue. Defaults
   * to 8. Everything shares one SSH channel, so an unbounded fan-out
   * only queues on that channel while holding a promise per directory;
   * the bound is what keeps a deep tree from doing that.
   */
  concurrency?: number;
  /**
   * Verify the host key. Receives the server's key and returns (or
   * resolves to) `true` to accept. Omitted, any host key is accepted,
   * which is fine on a trusted LAN and not fine across the internet.
   */
  hostVerifier?: (key: Buffer) => boolean | Promise<boolean>;
}

/** The SFTP status code for "no such file", from the protocol. */
const SFTP_NO_SUCH_FILE = 2;

/**
 * One SSH session per instance, reused across every operation and
 * re-established when the far side drops it.
 *
 * The reuse is not an optimisation, it is the difference between a
 * usable driver and an unusable one: a handshake is several round trips
 * plus key exchange, and `allFiles()` over a tree is one `readdir` per
 * directory. Per-call connections would make listing a media library
 * take minutes.
 *
 * The flip side of a long-lived connection is that it dies in ways a
 * fresh one can't: a NAS that spins down, a NAT table that forgets the
 * flow, an appliance with its own idle timeout. So a connection-level
 * failure on any operation is retried exactly once on a fresh
 * connection, and only a second failure surfaces. Once, not "until it
 * works", because an infinite retry against a host that is genuinely
 * gone is indistinguishable from a hang.
 */
export class SftpConnection {
  private client?: Client;
  private sftp?: SFTPWrapper;
  /** In-flight connect, so concurrent operations share one handshake rather than opening N sessions. */
  private connecting?: Promise<SFTPWrapper>;
  /** Absolute, home-resolved disk root. Known only once connected, since resolving `~` needs the server. */
  private base?: string;
  /** Whether the server offers `posix-rename@openssh.com`. Probed on first use, per connection. */
  private posixRename?: boolean;
  /** Whether the server offers `hardlink@openssh.com`. Probed on first use, per connection. */
  private openSshHardlink?: boolean;

  constructor(private readonly config: SftpConnectionConfig) {}

  /** Max concurrent requests the recursive walks issue. */
  concurrency(): number {
    return Math.max(1, this.config.concurrency ?? 8);
  }

  /** Open the session now, rather than on the first operation. `Connectable`'s half. */
  async connect(): Promise<void> {
    await this.sftpChannel();
  }

  /**
   * Close the session. Safe to call when never connected and safe to call
   * twice, both of which happen on a shutdown that follows a failed boot.
   */
  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.sftp = undefined;
    this.connecting = undefined;
    this.base = undefined;
    this.posixRename = undefined;
    this.openSshHardlink = undefined;

    if (!client) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      client.once("close", done);
      client.once("error", done);
      client.end();
      // A half-open socket must not hold shutdown open indefinitely.
      const timer = setTimeout(() => {
        client.destroy();
        done();
      }, 5_000);
      timer.unref();
    });
  }

  /** True while a session is open. */
  connected(): boolean {
    return this.sftp !== undefined;
  }

  /**
   * Run one SFTP operation, connecting first if needed and retrying once
   * on a fresh connection if the session turned out to be dead.
   *
   * Retrying is safe because a connection-level failure means the server
   * never processed the request: the bytes did not arrive, so replaying
   * them cannot duplicate an effect. An error the *server* produced
   * (no such file, permission denied) is not a connection error and is
   * never retried.
   */
  async run<T>(operation: (sftp: SFTPWrapper, base: string) => Promise<T>): Promise<T> {
    const sftp = await this.sftpChannel();

    try {
      return await operation(sftp, this.base!);
    } catch (error) {
      if (!isConnectionError(error)) {
        throw error;
      }

      await this.disconnect();
      const fresh = await this.sftpChannel();

      return operation(fresh, this.base!);
    }
  }

  /**
   * The disk root as an absolute remote path. Only meaningful once
   * connected, since a relative root is resolved against the login
   * user's home directory by the server.
   */
  async remoteRoot(): Promise<string> {
    await this.sftpChannel();

    return this.base!;
  }

  /**
   * Rename `from` onto `to`, replacing `to` if it exists.
   *
   * Plain SFTP `rename` is specified to **fail** when the target exists,
   * so an atomic replace needs OpenSSH's `posix-rename@openssh.com`
   * extension. Where the server offers it (OpenSSH does, which is nearly
   * every real deployment) this is a genuine atomic replace: a reader
   * sees either the old file or the new one.
   *
   * Where it doesn't, the fallback is unlink-then-rename, which has a
   * window in which the path does not exist. That is a real, documented
   * downgrade rather than a silent one: `replacesAtomically()` reports
   * which of the two a given connection got.
   */
  async rename(from: string, to: string): Promise<void> {
    await this.run(async (sftp) => {
      if (this.posixRename !== false) {
        try {
          await promisify<void>((cb) => sftp.ext_openssh_rename(from, to, cb));
          this.posixRename = true;

          return;
        } catch (error) {
          // The extension is missing entirely: ssh2 throws synchronously
          // before sending anything, so nothing has happened yet and the
          // fallback below is safe. Any other failure is a real error.
          if (!isUnsupportedExtension(error)) {
            throw error;
          }

          this.posixRename = false;
        }
      }

      await promisify<void>((cb) => sftp.unlink(to, () => cb(undefined)));
      await promisify<void>((cb) => sftp.rename(from, to, cb));
    });
  }

  /**
   * Whether this connection's server supports atomic replace, or
   * `undefined` before the first rename has probed for it.
   */
  replacesAtomically(): boolean | undefined {
    return this.posixRename;
  }

  /** A symlink at `linkPath` pointing at `target`. Core SFTP, always available. */
  async symlink(target: string, linkPath: string): Promise<void> {
    await this.run(async (sftp) => {
      await promisify<void>((cb) => sftp.symlink(target, linkPath, cb));
    });
  }

  /**
   * A hard link at `linkPath` for `target`, via
   * `hardlink@openssh.com`.
   *
   * Not part of the SFTP protocol — there is no standard way to make one
   * — so this is an OpenSSH extension. Resolves `false` when the server
   * never advertised it, which ssh2 reports by throwing synchronously
   * before sending anything, so nothing has happened on the far side and
   * the caller is free to do something else. Any other failure is a real
   * error and propagates.
   */
  async hardlink(target: string, linkPath: string): Promise<boolean> {
    if (this.openSshHardlink === false) {
      return false;
    }

    return this.run(async (sftp) => {
      try {
        await promisify<void>((cb) => sftp.ext_openssh_hardlink(target, linkPath, cb));
        this.openSshHardlink = true;

        return true;
      } catch (error) {
        if (!isUnsupportedExtension(error)) {
          throw error;
        }

        this.openSshHardlink = false;

        return false;
      }
    });
  }

  /**
   * Whether the server offers `hardlink@openssh.com`, or `undefined`
   * before anything has probed for it.
   *
   * There is no way to ask without attempting one, since ssh2 only
   * reports a missing extension at the point of use, so this stays
   * `undefined` until the first `hardlink()` call rather than connecting
   * eagerly to find out.
   */
  supportsHardlink(): boolean | undefined {
    return this.openSshHardlink;
  }

  /** `stat`, or `undefined` when the path does not exist. */
  async stat(remotePath: string): Promise<Stats | undefined> {
    return this.run(async (sftp) => {
      try {
        return await promisify<Stats>((cb) => sftp.stat(remotePath, cb));
      } catch (error) {
        if (isNoSuchFile(error)) {
          return undefined;
        }

        throw error;
      }
    });
  }

  /** Open (or reuse) the SFTP channel, resolving the disk root the first time. */
  private async sftpChannel(): Promise<SFTPWrapper> {
    if (this.sftp) {
      return this.sftp;
    }

    this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    });

    return this.connecting;
  }

  private async open(): Promise<SFTPWrapper> {
    const { Client } = await loadSsh2();
    const client = new Client();

    const connectOptions: ConnectConfig = {
      host: this.config.host,
      port: this.config.port ?? 22,
      username: this.config.username,
      password: this.config.password,
      privateKey: this.config.privateKey,
      passphrase: this.config.passphrase,
      keepaliveInterval: this.config.keepaliveInterval ?? 20_000,
      readyTimeout: this.config.readyTimeout ?? 20_000,
    };

    const { hostVerifier } = this.config;

    if (hostVerifier) {
      connectOptions.hostVerifier = (key: Buffer, callback: (accept: boolean) => void): void => {
        void Promise.resolve(hostVerifier(key)).then(
          (accepted) => callback(accepted),
          () => callback(false),
        );
      };
    }

    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      const fail = (error: Error): void => {
        client.removeAllListeners();
        client.destroy();
        reject(error);
      };

      client.once("error", fail);
      client.once("ready", () => {
        client.sftp((error, channel) => {
          if (error) {
            fail(error);

            return;
          }

          client.removeListener("error", fail);
          resolve(channel);
        });
      });

      client.connect(connectOptions);
    });

    // Once the far side drops the session, every cached handle is dead.
    // Clearing them here is what makes the next operation reconnect
    // rather than write into a closed channel.
    const invalidate = (): void => {
      if (this.client === client) {
        this.client = undefined;
        this.sftp = undefined;
        this.base = undefined;
        this.posixRename = undefined;
        this.openSshHardlink = undefined;
      }
    };
    client.once("close", invalidate);
    client.once("end", invalidate);
    // An `error` with no listener on an EventEmitter is an uncaught
    // exception, and a connection dropped while idle emits exactly that.
    client.on("error", invalidate);
    sftp.on("error", invalidate);

    this.client = client;
    this.sftp = sftp;
    this.base = await this.resolveRoot(sftp);

    return sftp;
  }

  /**
   * The absolute remote root. `realpath(".")` is the login directory,
   * which is what a relative root is relative to, and is asked for
   * rather than the root itself because the root is allowed not to exist
   * yet.
   */
  private async resolveRoot(sftp: SFTPWrapper): Promise<string> {
    const root = this.config.root ?? ".";

    if (path.posix.isAbsolute(root)) {
      return path.posix.normalize(root);
    }

    const home = await promisify<string>((cb) => sftp.realpath(".", cb));

    return path.posix.resolve(home, root);
  }
}

/** Turn one of ssh2's callback methods into a promise. */
export function promisify<T>(
  start: (callback: (error?: Error | null, value?: T) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    start((error, value) => {
      if (error) {
        reject(error);

        return;
      }

      resolve(value as T);
    });
  });
}

/** True when an SFTP error means "no such file or directory". */
export function isNoSuchFile(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const { code, message } = error as { code?: unknown; message?: unknown };

  return (
    code === SFTP_NO_SUCH_FILE ||
    code === "ENOENT" ||
    /no such file|not found/i.test(String(message ?? ""))
  );
}

/** ssh2 throws this synchronously when the server never advertised an extension. */
function isUnsupportedExtension(error: unknown): boolean {
  return /does not support this extended request/i.test(
    String((error as Error | undefined)?.message ?? ""),
  );
}

/**
 * True when the failure is the transport rather than the request: a dead
 * or never-established session. These are the only errors worth
 * retrying, a server that said "no such file" will say it again.
 */
export function isConnectionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const { code, message } = error as { code?: unknown; message?: unknown };

  if (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "ERR_STREAM_DESTROYED"
  ) {
    return true;
  }

  return /not connected|no response from server|channel|socket|closed|disconnect/i.test(
    String(message ?? ""),
  );
}

/**
 * Load `ssh2` on first use.
 *
 * It is an optional peer dependency, so an application that lists this
 * package but never resolves an SFTP disk never pays for an SSH stack,
 * and a missing one is reported here with the command that fixes it
 * rather than as a bare module-not-found from deep inside a driver.
 */
async function loadSsh2(): Promise<typeof import("ssh2")> {
  try {
    return await import("ssh2");
  } catch (error) {
    throw new Error(
      "The sftp storage driver needs the `ssh2` package, which is an optional peer dependency of " +
        "@mahiframework/storage-sftp. Install it: `npm install ssh2`.",
      { cause: error },
    );
  }
}
