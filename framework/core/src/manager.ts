/**
 * Generic Laravel `Illuminate\Support\Manager`-style driver resolver.
 *
 * A Manager resolves named "drivers" lazily and caches each resolved driver
 * independently. There is a *default* driver (see `getDefaultDriver()`), not
 * a single *only* driver, multiple drivers can be resolved and live
 * simultaneously (e.g. the default sqlite connection plus an explicitly
 * named analytics connection).
 *
 * Driver registration is always explicit via `extend()`. There is no
 * `create{Name}Driver` string-to-method dispatch magic. Subclasses register
 * their built-in drivers via `extend()` just like a third-party plugin
 * would register its own.
 *
 * Driver resolution is always synchronous. Constructing a driver handle is
 * assumed to be cheap (e.g. `new Kysely({ dialect })`, `new pg.Pool(cfg)`),
 * actual I/O happens lazily per-call regardless of driver. Drivers that
 * genuinely need an async warm-up implement the optional `Connectable`
 * interface and are connected explicitly by their owning ServiceProvider's
 * `boot()`, not by the Manager.
 *
 * Teardown is the mirror: a provider's `shutdown()` calls
 * `disconnectAll()`, which closes only the drivers that were actually
 * resolved. Resolving one in order to close it would construct the very
 * pool/socket shutdown exists to release.
 */

import type { Application } from "./application.js";

export type DriverFactory<TDriver> = (app: Application) => TDriver;

export class DriverNotRegisteredError extends Error {
  constructor(managerName: string, driverName: string) {
    super(`Driver "${driverName}" is not registered on ${managerName}.`);
    this.name = "DriverNotRegisteredError";
  }
}

/**
 * Optional contract for drivers that need an async warm-up before use
 * (e.g. a Postgres pool that pings the DB, an OAuth handshake for a model
 * provider). `Manager.driver()` itself is always synchronous, a driver's
 * owning ServiceProvider is responsible for calling `connect()` explicitly
 * during its own (already async-capable) `boot()`.
 */
export interface Connectable {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export function isConnectable(value: unknown): value is Connectable {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Connectable).connect === "function" &&
    typeof (value as Connectable).disconnect === "function"
  );
}

/**
 * The teardown half of `Connectable`, on its own.
 *
 * The two halves are genuinely independent: `SqliteDriver` has nothing to
 * warm up (better-sqlite3 connects synchronously in its constructor) but
 * very much has a file handle to close. Requiring a no-op `connect()`
 * from it just to be disconnectable would be ceremony. And would make
 * `DatabaseServiceProvider.boot()` "connect" it for no reason.
 */
export function isDisconnectable(value: unknown): value is Pick<Connectable, "disconnect"> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Connectable).disconnect === "function"
  );
}

export abstract class Manager<TDriver = unknown> {
  protected resolved = new Map<string, TDriver>();
  protected creators = new Map<string, DriverFactory<TDriver>>();

  constructor(protected app: Application) {}

  /**
   * The driver name to resolve when `driver()` is called without an
   * explicit name argument. Typically reads from config, e.g.
   * `this.app.config.get("database.default")`.
   */
  abstract getDefaultDriver(): string;

  /**
   * Register a driver factory under a given name. Both built-in drivers
   * (registered by the manager's own owning ServiceProvider) and
   * plugin-contributed drivers use this same method.
   */
  extend(name: string, factory: DriverFactory<TDriver>): this {
    this.creators.set(name, factory);
    // Re-registering a driver invalidates any handle already resolved under
    // that name, so the next `driver(name)` rebuilds from the new factory
    // rather than silently returning the stale cached instance.
    this.resolved.delete(name);

    return this;
  }

  /**
   * Resolve (and cache) a driver by name, or the default driver if no name
   * is given. Always synchronous. See module doc above.
   */
  driver(name?: string): TDriver {
    const key = name ?? this.getDefaultDriver();

    // `has()`, not a `!== undefined` check on `get()`: a factory that
    // legitimately returns a falsy driver would otherwise be re-invoked on
    // every call, and this would disagree with `isResolved()`.
    if (this.resolved.has(key)) {
      return this.resolved.get(key) as TDriver;
    }

    const create = this.creators.get(key);

    if (!create) {
      throw new DriverNotRegisteredError(this.constructor.name, key);
    }

    const driver = create(this.app);
    this.resolved.set(key, driver);

    return driver;
  }

  /**
   * True if a driver has been resolved (and therefore cached) under this
   * name already.
   */
  isResolved(name: string): boolean {
    return this.resolved.has(name);
  }

  /**
   * All currently-resolved driver names.
   */
  resolvedDriverNames(): string[] {
    return [...this.resolved.keys()];
  }

  /**
   * Every driver resolved so far, in resolution order.
   *
   * The shutdown counterpart to lazy resolution: an owning
   * ServiceProvider's `shutdown()` disconnects what was actually built,
   * without resolving (and therefore *constructing*) anything new just to
   * tear it down. Named connections an app reached for at runtime are
   * included; ones it never touched were never opened.
   */
  resolvedDrivers(): TDriver[] {
    return [...this.resolved.values()];
  }

  /**
   * Drop one driver: disconnect the resolved instance if there is one,
   * and forget its factory, so the name is unregistered rather than
   * merely uncached. Returns `true` if anything was actually dropped.
   *
   * `extend()` already invalidates a cached instance, so re-registering a
   * name is enough to *replace* a driver. This is for the case where the
   * name goes away entirely, a disk built from a database row whose row
   * was deleted, say. Without it the only thing that ever calls
   * `disconnect()` is `disconnectAll()`, so dropping a connected driver
   * by any other route leaks whatever socket it was holding.
   *
   * Disconnection failures propagate: unlike shutdown, this is a
   * deliberate single-target operation whose caller is in a position to
   * handle the error.
   */
  async forget(name: string): Promise<boolean> {
    const driver = this.resolved.get(name);
    const wasResolved = this.resolved.delete(name);
    const wasRegistered = this.creators.delete(name);

    if (isDisconnectable(driver)) {
      await driver.disconnect();
    }

    return wasResolved || wasRegistered;
  }

  /**
   * Call `disconnect()` on every resolved driver that has one, then
   * forget them, so the manager can resolve fresh ones if it is somehow
   * used again.
   *
   * Best-effort by design (shutdown is): every driver is attempted even
   * if an earlier one rejects, and the rejections are collected and
   * returned rather than thrown, one unreachable Redis must not leave a
   * MySQL pool open and hang the process. Callers that care (a
   * provider's `shutdown()`) log what comes back.
   */
  async disconnectAll(): Promise<unknown[]> {
    const drivers = this.resolvedDrivers();
    this.resolved.clear();

    const errors: unknown[] = [];

    for (const driver of drivers) {
      if (!isDisconnectable(driver)) {
        continue;
      }

      try {
        await driver.disconnect();
      } catch (error) {
        errors.push(error);
      }
    }

    return errors;
  }
}
