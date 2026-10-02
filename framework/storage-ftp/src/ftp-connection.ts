import path from "node:path";
import type { Client, FileInfo } from "basic-ftp";
import type { ConnectionOptions as TLSConnectionOptions } from "node:tls";

export interface FtpConnectionConfig {
  host: string;
  port?: number;
  user: string;
  password?: string;
  /**
   * FTPS. `true` is explicit TLS (`AUTH TLS`) and is what you want;
   * `"implicit"` is the legacy, non-standardized variant some appliances
   * only speak.
   *
   * Omitted means **plain FTP, in cleartext** — credentials and file
   * contents both. That is the protocol's default rather than this
   * driver's preference, and it is only a reasonable choice on a trusted
   * LAN.
   */
  secure?: boolean | "implicit";
  secureOptions?: TLSConnectionOptions;
  /** Remote base directory. Relative paths resolve against the login directory. */
  root?: string;
  /** Per-command timeout in ms. Defaults to 30s, `basic-ftp`'s own default. */
  timeout?: number;
  /**
   * Log the FTP conversation to stderr. Useful when a server's `LIST`
   * dialect or passive-mode advertisement is the thing misbehaving.
   */
  verbose?: boolean;
}

/**
 * One FTP control connection, with every operation serialised.
 *
 * The serialisation is the whole point of this type, and it is not a
 * conservative choice. FTP has a single control connection carrying one
 * command at a time, and `basic-ftp` enforces that by throwing
 * `"User launched a task while another one is still running"` rather than
 * corrupting the session. Two concurrent `size()` calls on one client is
 * enough to trigger it.
 *
 * So, unlike `SftpConnection` — which runs a bounded worker *pool* over
 * one SSH channel — everything here queues behind a promise chain. The
 * cost is real and unavoidable: a recursive `allFiles()` over a deep tree
 * is strictly sequential round trips. The alternative, a pool of control
 * connections, multiplies logins and still can't make one connection
 * concurrent.
 *
 * The other thing kept in here is the working directory. `ensureDir()`
 * *leaves the client cd'd into the directory it created*, which silently
 * breaks every later relative path, so this type only ever issues
 * absolute paths and restores the cwd afterwards.
 */
export class FtpConnection {
  private client?: Client;
  /** In-flight connect, so concurrent first operations share one login. */
  private connecting?: Promise<Client>;
  /** Absolute, login-resolved disk root. Known only once connected. */
  private base?: string;
  /** The tail of the operation queue. Every call chains onto this. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Whether the server advertised `MLSD`, probed once per connection. */
  private mlsd?: boolean;
  /** Whether `rename` replaced an existing target, learned on first attempt. */
  private atomicReplace?: boolean;

  constructor(private readonly config: FtpConnectionConfig) {}

  connected(): boolean {
    return this.client !== undefined && !this.client.closed;
  }

  /**
   * Whether the server supports machine-readable listings.
   *
   * Without `MLSD` the driver falls back to `LIST`, whose timestamps are
   * human-formatted and year-less, so `lastModified()` has to ask per file
   * with `MDTM` instead of reading the listing. `undefined` until probed.
   */
  supportsMlsd(): boolean | undefined {
    return this.mlsd;
  }

  /**
   * Whether a rename over an existing file replaced it atomically.
   *
   * `undefined` until a replacing rename has actually been attempted. The
   * FTP spec doesn't require `RNFR`/`RNTO` to clobber an existing target,
   * and implementations differ — vsftpd allows it, others refuse — so a
   * refusal degrades to delete-then-rename, which has a window where the
   * destination doesn't exist. That downgrade is reported rather than
   * hidden.
   */
  replacesAtomically(): boolean | undefined {
    return this.atomicReplace;
  }

  /** Record how a replacing rename went, for `replacesAtomically()`. */
  recordReplace(atomic: boolean): void {
    this.atomicReplace = atomic;
  }

  /** Open the control connection and log in. */
  async connect(): Promise<void> {
    await this.run(async () => undefined);
  }

  /**
   * Close the control connection. Idempotent, and safe when never
   * connected.
   */
  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.base = undefined;
    this.mlsd = undefined;
    this.atomicReplace = undefined;

    if (client === undefined) {
      return;
    }

    try {
      client.close();
    } catch {
      // A close that fails has still released what we care about.
    }
  }

  /**
   * Queue an operation, retrying once on a dropped connection.
   *
   * The retry is safe for the same reason it is in the SFTP driver: a
   * transport failure means the server never processed the request. A
   * server-level refusal (550, 553) is not a connection error and is never
   * retried.
   */
  async run<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    const result = this.queue.then(
      () => this.attempt(operation),
      () => this.attempt(operation),
    );

    // The queue must survive a failed operation, so the chain it carries is
    // always a resolved one; callers get the real result from `result`.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  private async attempt<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    try {
      return await operation(await this.channel());
    } catch (error) {
      if (!isConnectionError(error)) {
        throw error;
      }

      // The session is gone; a fresh one is the only way to continue.
      await this.disconnect();

      return operation(await this.channel());
    }
  }

  /** The absolute remote root, resolved against the login directory. */
  async remoteRoot(): Promise<string> {
    if (this.base !== undefined) {
      return this.base;
    }

    // Resolving the root needs the server: a relative `root` is relative to
    // whatever directory the login lands in.
    return this.run(async () => this.base ?? "/");
  }

  /**
   * One directory level. A missing directory lists as empty rather than
   * throwing, matching every other driver.
   */
  async list(absolute: string): Promise<FileInfo[]> {
    return this.run(async (client) => {
      try {
        return await client.list(absolute);
      } catch (error) {
        if (isMissing(error)) {
          return [];
        }

        throw error;
      }
    });
  }

  /**
   * Create a directory and its parents, then restore the working
   * directory.
   *
   * `ensureDir()` is implemented as a sequence of `CWD`/`MKD`, so it
   * leaves the client inside the directory it just made. Every relative
   * path issued afterwards would resolve from there. Restoring the cwd is
   * what makes this safe to call mid-operation.
   */
  async ensureDirectory(absolute: string): Promise<void> {
    await this.run(async (client) => {
      const previous = await client.pwd();

      try {
        await client.ensureDir(absolute);
      } finally {
        await client.cd(previous).catch(() => {});
      }
    });
  }

  private async channel(): Promise<Client> {
    if (this.client !== undefined && !this.client.closed) {
      return this.client;
    }

    this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    });

    return this.connecting;
  }

  private async open(): Promise<Client> {
    const { Client } = await loadBasicFtp();
    const client = new Client(this.config.timeout ?? 30_000);
    client.ftp.verbose = this.config.verbose ?? false;

    try {
      await client.access({
        host: this.config.host,
        port: this.config.port ?? 21,
        user: this.config.user,
        password: this.config.password,
        secure: this.config.secure ?? false,
        secureOptions: this.config.secureOptions,
      });

      const features = await client.features();
      this.mlsd = features.has("MLSD");

      const login = await client.pwd();
      const root = (this.config.root ?? "").replace(/\\/g, "/");
      this.base = path.posix.isAbsolute(root)
        ? path.posix.normalize(root).replace(/\/+$/, "")
        : path.posix.resolve(login, root).replace(/\/+$/, "");

      this.client = client;

      return client;
    } catch (error) {
      client.close();

      throw error;
    }
  }
}

/**
 * Whether an error is the server refusing a file operation, rather than a
 * transport failure.
 *
 * `550` covers "no such file or directory" and "permission denied"; `553`
 * is the "could not create file" a write into a non-existent directory
 * produces. Both mean the connection is fine and the request was not.
 */
export function isMissing(error: unknown): boolean {
  const code = (error as { code?: number | string })?.code;

  if (code === 550 || code === "550" || code === 553 || code === "553") {
    return true;
  }

  return /no such file|not found|cannot find|could not create/i.test(
    (error as Error)?.message ?? "",
  );
}

/**
 * Whether an error means the control connection is unusable *and* the
 * request never reached the server, so retrying it once is safe.
 *
 * Deliberately narrow. A transfer whose source stream was destroyed — an
 * aborted upload — also leaves `basic-ftp`'s client closed, but the error
 * carries the *caller's* message and the request was already in flight.
 * Retrying that would re-run an operation the caller cancelled, so only
 * transport-level failures qualify and the caller's own error is passed
 * through untouched.
 */
export function isConnectionError(error: unknown): boolean {
  const candidate = error as { code?: number | string; message?: string };
  const code = candidate?.code;

  if (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === 421
  ) {
    return true;
  }

  // `basic-ftp` reports a closed or timed-out client as a plain Error, so
  // these are matched on the message. "Client is closed because <cause>"
  // is excluded: the cause is what actually went wrong, and it is usually
  // the caller destroying the stream.
  const message = candidate?.message ?? "";

  if (/client is closed because/i.test(message)) {
    return false;
  }

  return /client is closed|timeout exceeded|timed out|not connected|socket hang up/i.test(message);
}

/**
 * Load `basic-ftp` on first use.
 *
 * An optional peer dependency, so an application with no FTP disk never
 * installs it, and one with a registered-but-unused FTP disk never loads
 * it.
 */
async function loadBasicFtp(): Promise<typeof import("basic-ftp")> {
  try {
    return await import("basic-ftp");
  } catch (error) {
    throw new Error(
      "The ftp storage driver needs the `basic-ftp` package, which is an optional peer " +
        "dependency of @mahiframework/storage-ftp. Install it: `npm install basic-ftp`.",
      { cause: error },
    );
  }
}

/** Type-only re-exports, so consumers needn't import `basic-ftp` for signatures. */
export type { Client, FileInfo };
