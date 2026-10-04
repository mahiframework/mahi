import { ServiceProvider } from "@mahiframework/core";
import type { AnyModelClass } from "@mahiframework/database";
import type { Router, Request, HttpPipe } from "@mahiframework/http";
import {
  RateLimiter,
  Limit,
  RATE_LIMITER_TOKEN,
  trustProxies,
  trustHosts,
  hostsFromUrl,
} from "@mahiframework/http";
import type { Schedule } from "@mahiframework/schedule";
import { servePublicDisk, serveTemporaryDiskFile } from "@mahiframework/storage";
import type { Env } from "../../config/env.js";
// `AuthGcCommand` is invoked directly by the scheduled task below rather
// than re-registered via `commands()`, `AuthServiceProvider` already
// contributes it, and registering the same signature twice makes the
// ConsoleKernel throw at startup.
import { AuthGcCommand } from "@mahiframework/auth";
import { User } from "../models/user.model.js";
import { registerAuthRoutes } from "../routes/auth.routes.js";
import { DatabaseSeeder } from "../../database/seeders/database-seeder.js";

/**
 * Your application's service provider, the single place to wire up
 * everything the app owns. As the app grows, split this into one provider
 * per feature and list them all in `config/app.ts`.
 *
 * Every method below is an optional hook, collected by the framework
 * during boot:
 *
 * - `register()`, bind services into the container. Runs for *every*
 *   provider before any `boot()` does, so never resolve another
 *   provider's bindings here.
 * - `boot()`. Everything is registered; safe to resolve.
 * - `routes()`, receives the root `Router`.
 * - `models()`, models that can appear in queued job payloads.
 * - `seeders()`, seeders `db:seed` can run.
 * - `schedule()`, recurring tasks.
 * - `checks()`, readiness checks for `/health` and `./artisan health`.
 *
 * Others exist too: `commands()`, `listeners()`, `jobs()`, `gates()`,
 * `middleware()`, `migrations()`.
 */
export class AppServiceProvider extends ServiceProvider {
  // Add a `register()` here for bindings and class metadata; it runs
  // before any provider's `boot()`. One thing worth pinning in it is the
  // discriminant values polymorphic relations write into `*_type` columns
  // (`commentable_type`, `notifiable_type`, ...). Without a map those
  // values fall back to the model's `morphName`, then its `table`, which
  // couples what's stored in your database to how your code is named, so
  // renaming a table orphans existing rows:
  //
  //   register(): void {
  //     Relation.morphMap({
  //       user: () => User,
  //     });
  //   }
  //
  // `User` sets `morphName = "User"`, so notifications sent to a `User`
  // store `notifiable_type = "User"` by default. Map it to something else
  // if you'd rather store a different string, do it before any rows
  // exist, or migrate the existing ones.
  //
  // `Relation.enforceMorphMap({ ... })` additionally makes the map
  // mandatory, so adding a polymorphic model without registering it
  // throws instead of silently writing a table name. Worth doing once you
  // have more than one.
  //
  // Note the thunks: `() => User`, never `User`. This method runs at
  // import time, and a bare class reference would hit a temporal-dead-zone
  // error on a circular import.

  /**
   * Rate limiters for the unauthenticated endpoints, referenced by name
   * from `throttle("login")` / `throttle("register")` / `throttle("passwords")`.
   *
   * Login is keyed by EMAIL + IP rather than IP alone: keying on IP only
   * lets an attacker spread guesses for one account across many
   * addresses, while keying on email only lets one attacker lock a victim
   * out of their own account by burning the limit deliberately. Combining
   * them bounds both.
   *
   * `passwords` covers the reset and verification endpoints. It is keyed
   * by IP and is only half the story: the per-MAILBOX throttle lives in
   * `auth.passwords.throttleSeconds` and is what actually stops an
   * attacker rotating IPs to flood one victim's inbox. This bounds how
   * fast one client can drive the endpoint at all.
   */
  boot(): void {
    const limiter = this.app.make<RateLimiter>(RATE_LIMITER_TOKEN);

    limiter.for("login", async (request: Request) =>
      Limit.perMinute(5).by(await loginKey(request)),
    );
    limiter.for("register", (request: Request) => Limit.perMinute(10).by(clientIp(request)));
    limiter.for("passwords", (request: Request) => Limit.perMinute(6).by(clientIp(request)));
  }

  /**
   * Global middleware, run on every request ahead of route dispatch.
   *
   * Both pipes here are about **whom the app believes**, and both are
   * registered first on purpose: everything downstream (rate limiting,
   * generated links, audit logs) is built on the answers.
   *
   * `trustProxies()`, decides whether `X-Forwarded-*` may be read at
   * all. Without it `request.ip()` is the socket peer, which behind a
   * load balancer is the balancer, so every client shares one rate-limit
   * bucket; with it wrongly set to `*` on a directly reachable host,
   * any client can forge its own address and rate limiting stops
   * working. Configure `TRUSTED_PROXIES` to match your actual topology.
   * It also applies `X-Forwarded-Proto`, which is what makes
   * `secure()` true and generated links `https://` behind a TLS
   * terminator.
   *
   * `trustHosts()`, rejects a request whose `Host` isn't one of yours.
   * The URL generator prefers the live request's host, so without this
   * an attacker POSTs to "forgot password" with `Host: evil.example`
   * and the victim gets a genuine signed link to the attacker's site.
   */
  middleware(): HttpPipe[] {
    const env = this.app.make<Env>("env");
    const pipes: HttpPipe[] = [];

    const proxies = splitList(env.TRUSTED_PROXIES);

    if (proxies.length > 0) {
      pipes.push(trustProxies(proxies));
    }

    // Explicit `*` disables host checking; otherwise fall back to the
    // host in APP_URL, which the app already has to get right.
    const hosts = splitList(env.TRUSTED_HOSTS);

    if (!hosts.includes("*")) {
      const allowed = hosts.length > 0 ? hosts : hostsFromUrl(env.APP_URL);

      // Outside production, also accept the other names the same machine
      // answers to. `APP_URL` is `http://localhost:8000`, so deriving
      // the allow-list from it alone means curling `127.0.0.1:8000`,
      // which is the same server, gets a 403 "Untrusted host." That
      // reads as a broken app rather than a deliberate policy, and the
      // usual fix a developer reaches for is to delete this middleware.
      // Production gets no such widening.
      if (!this.app.isProduction()) {
        allowed.push("localhost", "127.0.0.1", "[::1]", "0.0.0.0");
      }

      // `trustHosts([])` would reject everything, so only register when
      // there is actually something to allow.
      if (allowed.length > 0) {
        pipes.push(trustHosts(allowed));
      }
    }

    return pipes;
  }

  routes(router: Router): void {
    registerAuthRoutes(router);

    // Signed, expiring links to files on a PRIVATE disk, which is what
    // `Storage.temporaryUrl(path)` returns for any disk configured with
    // `temporaryUrls: true`. The handler verifies the signature itself,
    // so no middleware is required here, and refuses any disk that did
    // not opt in. Registered before the `/storage/*` catch-all below,
    // which would otherwise swallow this more specific path.
    router.get("/storage/temporary/*", serveTemporaryDiskFile()).name("storage.temporary");

    // Serve the `public` storage disk at its configured `url` prefix
    // (`/storage/*`), so `Storage.disk("public").url(path)` resolves to a
    // real download. The `default` disk is `local` (private) and is
    // deliberately NOT served here; hand out a `temporaryUrl()` for a
    // one-off download, or stream it through your own authorised route
    // with `serveStoredFile` when a file needs a real permission check.
    router.get("/storage/*", servePublicDisk("public")).name("storage.public");
  }

  /**
   * Declare who may subscribe to `private-`/`presence-` broadcast
   * channels. Public (unprefixed) channels stay open to any client and
   * need nothing here.
   *
   * The callback receives the socket's authenticated user (resolved by the
   * guards in `config/broadcasting.ts`, `null` for a guest) plus any
   * `{param}` captured from the channel name. Return a boolean for a
   * private channel, or the member payload (or `false`) for a presence
   * channel.
   *
   *   channels(broadcast: ChannelRegistry): void {
   *     broadcast.channel("users.{userId}", (user, userId) =>
   *       (user as User | null)?.id === userId);
   *
   *     broadcast.channel("presence-room.{room}", (user) =>
   *       user ? { id: (user as User).id, name: (user as User).name } : false);
   *   }
   *
   * Adding it also needs the type import at the top of this file:
   * `import type { ChannelRegistry } from "@mahiframework/broadcasting";`
   */

  /**
   * Models listed here can be passed directly into queued jobs. They
   * serialize to `{ __model, __id }` and rehydrate before `handle()`
   * runs. Requires a `static morphName` on the model.
   */
  models(): Array<AnyModelClass> {
    return [User];
  }

  /** `db:seed`'s default seeder. */
  seeders() {
    return [DatabaseSeeder];
  }

  /**
   * Readiness checks. The things that must be working for this instance
   * to serve traffic. Surfaced by `GET /health` and `./artisan health`.
   *
   * `@mahiframework/health` already checks the cache, database and default storage
   * disk under the `core` group. Add the dependencies only your app knows
   * about, a third-party API, a background daemon, a licence that
   * expires:
   *
   *   checks(): HealthCheck[] {
   *     return [
   *       {
   *         name: "stripe",
   *         async run() {
   *           const res = await fetch("https://api.stripe.com/healthcheck");
   *           if (!res.ok) return `Stripe returned ${res.status}`;
   *         },
   *       },
   *     ];
   *   }
   *
   * Throw or return a string to fail, return nothing to pass, return
   * `null` to skip. Checks must be CHEAP and constant-cost. This runs on
   * every probe interval, on every instance. Never a table scan.
   *
   * Adding it also needs the type import at the top of this file:
   * `import type { HealthCheck } from "@mahiframework/health";`
   */

  /**
   * Sessions and password-reset tokens expire on read, but nothing
   * deletes the stale rows. So run the framework's `auth:gc` daily.
   *
   * `name()` is required here, not decorative: it is the key of the
   * `withoutOverlapping()` lock, and the app refuses to boot without one.
   */
  schedule(schedule: Schedule): void {
    schedule
      .call(async (app) => {
        await new AuthGcCommand(app).handle();
      })
      .daily()
      .name("auth-gc")
      .withoutOverlapping();
  }
}

/** Split a comma-separated env list, dropping blanks. */
function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function clientIp(request: Request): string {
  return request.ip() ?? "unknown";
}

/**
 * Keys the login limiter by email + IP.
 *
 * Runs BEFORE validation, so it must tolerate a missing or malformed
 * body. `Request.from()` has already parsed the JSON (or `{}` on
 * garbage), so reading `input("email")` here doesn't consume anything the
 * validator needs later.
 */
async function loginKey(request: Request): Promise<string> {
  const email = request.input("email");
  const identifier = typeof email === "string" && email !== "" ? email.toLowerCase() : "unknown";

  return `${identifier}|${clientIp(request)}`;
}
