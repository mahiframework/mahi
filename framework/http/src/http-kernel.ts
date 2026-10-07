import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { METHOD_NAME_ALL } from "hono/router";
import { TrieRouter } from "hono/router/trie-router";
import { createNodeWebSocket, type NodeWebSocket } from "@hono/node-ws";
import type { ServerType } from "@hono/node-server";
import { runInvocationScope, type Application } from "@mahiframework/core";
import type { WebSocketSupport } from "./websocket.js";
import { Router } from "./router.js";
import { RouteRegistry } from "./route-registry.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { HttpError } from "./http-error.js";
import {
  createErrorHandler,
  ErrorRendererRegistry,
  type ErrorPredicate,
  type ErrorRenderer,
} from "./middleware/error-handler.js";
import { toHonoMiddleware, type HttpPipe } from "./middleware/pipeline-middleware.js";
import type { HttpConfig } from "./http-config.js";
import { MaintenanceMode, MAINTENANCE_MODE_TOKEN } from "./maintenance/maintenance-mode.js";
import { maintenanceMiddleware } from "./maintenance/maintenance-middleware.js";
import {
  HEALTH_TOKEN,
  redactFailures,
  shouldRedact,
  type HealthRegistryLike,
} from "./health-check-route.js";

export interface RegisteredRoute {
  method: string;
  path: string;
  name?: string;
}

/**
 * Default maximum non-multipart request body: 1 MiB. See
 * `HttpBodyLimitConfig` for why there is a default at all.
 */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** Default maximum `multipart/form-data` request body: 10 MiB. */
export const DEFAULT_MAX_MULTIPART_BYTES = 10 * 1024 * 1024;

/**
 * `bodyLimit()`'s rejection path. Throws `HttpError` rather than
 * returning a response so the 413 goes through the central error
 * handler and comes out in the same JSON envelope as every other error.
 */
function tooLarge(_c: Context): never {
  throw HttpError.payloadTooLarge();
}

/**
 * Wraps a Hono app instance. Collects every provider's `routes()` hook and
 * mounts them onto the root Hono instance, and installs the central error
 * handler.
 */
export class HttpKernel {
  private hono = new Hono();
  private registry = new RouteRegistry();
  private router = new Router(this.hono, this.registry);
  private routes: RegisteredRoute[] = [];
  private errorRenderers = new ErrorRendererRegistry();
  private websockets?: WebSocketSupport;

  /**
   * Lazily-built path → methods index, used only to turn a 404 into a
   * 405. See `methodsFor()`.
   */
  private methodIndex?: TrieRouter<string[]>;

  /**
   * The `ws` server behind `websocketSupport()`, kept only so shutdown
   * can close the sockets it is holding open. See `closeWebSockets()`.
   * Deliberately not part of `WebSocketSupport`: that type exists to keep
   * `wss` out of consumers' reach, and nothing outside this class should
   * be touching the socket server. Typed off `NodeWebSocket` rather
   * than imported from `ws` so this package keeps its single `ws` type
   * source (the one `@hono/node-ws` already pins).
   */
  private wss?: NodeWebSocket["wss"];

  /**
   * The global pipes, resolved at REQUEST time.
   *
   * Held in a mutable array rather than closed over at registration, because
   * of an easily-missed Hono property: `use("*")` only applies
   * to routes registered AFTER it. The pipes themselves are not known until
   * `collectFromProviders()` has walked every provider, but a provider that
   * mounts directly onto `raw()`, a websocket upgrade is the only practical
   * way to do that, can have registered its route before then.
   *
   * Such a route would then be matched with NO global middleware on it at all:
   * no context scope, no maintenance check, and no auth. That is not a
   * degraded state, it is an unauthenticated one, and nothing about it is
   * visible from the route table.
   *
   * So the `use("*")` slot is claimed in the constructor, which runs in
   * `HttpServiceProvider.register()`, before any provider's `boot()`, and
   * this array is filled in later. The indirection is the fix.
   */
  private pipes: HttpPipe[] = [];

  constructor(private app: Application) {
    this.hono.onError(createErrorHandler(app, this.errorRenderers));
    this.installNotFoundHandler();
    // Order below is the order these run in, and each step depends on the
    // previous one having already happened:
    //   1. security headers wrap everything, so they are present on error
    //      responses and on the 404 too;
    //   2. the body limit rejects oversize payloads BEFORE the global
    //      pipe constructs a Request and parses the body;
    //   3. CORS;
    //   4. the global Mahi pipe slot.
    this.installSecurityHeaders();
    this.installBodyLimit();
    this.installCors();
    this.claimMiddlewareSlot();
  }

  /**
   * Put the global middleware ahead of every route that will ever be
   * registered, before any of them exist. See `pipes`.
   */
  private claimMiddlewareSlot(): void {
    // `() => this.pipes` rather than the array itself: the slot is claimed
    // now and the contents arrive later.
    this.hono.use(
      "*",
      toHonoMiddleware(() => this.pipes),
    );
  }

  /**
   * Configured liveness path (`/up` by default), or undefined when
   * disabled.
   */
  private livenessPath(): string | undefined {
    const config = this.app.config.get<HttpConfig["liveness"]>("http.liveness");

    if (!config) {
      return undefined;
    }

    return config.path ?? "/up";
  }

  /**
   * Register a custom error renderer, an app-supplied `(predicate,
   * renderer)` pair consulted before the built-in `HttpError`/
   * `ValidationException` mapping. Use this to shape responses from errors
   * whose throw site the app doesn't control (e.g. a library's
   * constraint-violation error), which would otherwise fall through to the
   * generic 500. Typically called from a provider's `boot()`:
   *
   *   kernel.registerRenderer(
   *     (e): e is DatabaseError => e instanceof DatabaseError,
   *     (e, c) => c.json({ error: "Conflict", detail: e.detail }, 409),
   *   );
   */
  registerRenderer<E extends Error>(predicate: ErrorPredicate<E>, render: ErrorRenderer<E>): void {
    this.errorRenderers.register(predicate, render);
  }

  /**
   * Installs hono/cors globally, ahead of every provider's routes, if the
   * app has set the `"http.cors"` config namespace (e.g. so a frontend on
   * a different origin can call this API). No-op if that config key isn't
   * set. CORS stays opt-in.
   */
  private installCors(): void {
    const config = this.app.config.get<HttpConfig["cors"]>("http.cors");

    if (!config) {
      return;
    }

    this.hono.use("*", cors(config));
  }

  /**
   * Answer unmatched routes in the same JSON envelope as every other
   * error, and answer a method mismatch with a 405 + `Allow` rather than
   * a 404.
   *
   * Hono's default `notFound` returns the plain text `404 Not Found`, so
   * an API had two error shapes: a JSON `{"message":"..."}` from any
   * handled error, and bare text from a typo'd URL. A client parsing the
   * former chokes on the latter, which surfaces as "the API returned
   * invalid JSON" rather than "you requested a path that doesn't exist".
   *
   * The 405 matters more than it looks: Hono reports an existing path
   * requested with the wrong method as a 404, so a client calling `GET`
   * on a `POST`-only endpoint is told the route does not exist and goes
   * looking for a deployment problem. `Allow` is mandatory on a 405 (RFC
   * 9110 §15.5.6) and names the methods that would have worked.
   */
  private installNotFoundHandler(): void {
    this.hono.notFound((c) => {
      const allowed = this.methodsFor(c.req.path);

      if (allowed.length > 0 && !allowed.includes(c.req.method)) {
        return c.json({ message: "Method Not Allowed" }, 405, { Allow: allowed.join(", ") });
      }

      return c.json({ message: "Not Found" }, 404);
    });
  }

  /**
   * The HTTP methods registered for a concrete request path.
   *
   * Backed by a second, tiny `TrieRouter` built lazily from
   * `hono.routes`, mapping each registered PATH to the set of methods
   * declared on it, the same technique Hono's own `methodNotAllowed`
   * middleware uses, and for the same reason: the main router is indexed
   * by (method, path) and can only answer "did this exact pair match?",
   * never "what else would have?".
   *
   * Built on first 404 rather than at registration time, because routes
   * are still being collected while the kernel is constructed. Cached
   * afterwards. A 404 is a plausible flood target and rebuilding a trie
   * per request would make that flood cheaper for the attacker than for
   * us.
   */
  private methodsFor(path: string): string[] {
    this.methodIndex ??= this.buildMethodIndex();

    const allowed = new Set<string>();
    const [matches] = this.methodIndex.match(METHOD_NAME_ALL, path);

    for (const [methods] of matches) {
      for (const method of methods) {
        allowed.add(method);
      }
    }

    // A GET route answers HEAD too, Hono dispatches it, so a HEAD
    // request to a GET-only path must not be told the method is
    // disallowed.
    if (allowed.has("GET")) {
      allowed.add("HEAD");
    }

    return [...allowed];
  }

  private buildMethodIndex(): TrieRouter<string[]> {
    const methodsByPath = new Map<string, Set<string>>();

    for (const route of this.hono.routes) {
      // `ALL` entries are `use()` middleware, not routes, every path
      // "matches" them, so including them would make every 404 a 405.
      if (route.method === METHOD_NAME_ALL) {
        continue;
      }

      const methods = methodsByPath.get(route.path) ?? new Set<string>();
      methods.add(route.method);
      methodsByPath.set(route.path, methods);
    }

    const index = new TrieRouter<string[]>();

    for (const [routePath, methods] of methodsByPath) {
      index.add(METHOD_NAME_ALL, routePath, [...methods]);
    }

    return index;
  }

  /**
   * Request body size limits. See `HttpBodyLimitConfig` for why these
   * are on by default.
   *
   * Mounted ahead of the global Mahi pipe so an oversize body is
   * rejected before `Request` is constructed and `c.req.json()` pulls it
   * into memory. Multipart gets its own, larger ceiling: it is the
   * upload path, and applying a JSON-sized limit to it would break file
   * uploads at 1 MiB.
   *
   * `bodyLimit()` throws Hono's `HTTPException(413)`, which the central
   * error handler maps into the JSON envelope.
   */
  private installBodyLimit(): void {
    const config = this.app.config.get<HttpConfig["bodyLimit"]>("http.bodyLimit") ?? {};
    const maxBytes = config.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
    const maxMultipartBytes = config.maxMultipartBytes ?? DEFAULT_MAX_MULTIPART_BYTES;

    if (maxBytes <= 0 && maxMultipartBytes <= 0) {
      return;
    }

    const jsonLimit =
      maxBytes > 0 ? bodyLimit({ maxSize: maxBytes, onError: tooLarge }) : undefined;
    const multipartLimit =
      maxMultipartBytes > 0
        ? bodyLimit({ maxSize: maxMultipartBytes, onError: tooLarge })
        : undefined;

    this.hono.use("*", async (c, next) => {
      const isMultipart = (c.req.header("content-type") ?? "").includes("multipart/form-data");
      const limit = isMultipart ? multipartLimit : jsonLimit;

      if (!limit) {
        return next();
      }

      return limit(c, next);
    });
  }

  /**
   * Response security headers. See `HttpSecurityHeadersConfig`. On by
   * default; `{ enabled: false }` installs none.
   */
  private installSecurityHeaders(): void {
    const config = this.app.config.get<HttpConfig["securityHeaders"]>("http.securityHeaders") ?? {};

    if (config.enabled === false) {
      return;
    }

    this.hono.use("*", securityHeaders(config));
  }

  /**
   * Collect `middleware()` and `routes()` from every registered provider.
   * `middleware()` pipes are collected first and installed as a single
   * global Hono middleware (see `toHonoMiddleware`) ahead of route
   * dispatch, run in provider registration order via
   * `@mahiframework/pipeline`'s `Pipeline` rather than Hono's own
   * middleware composition.
   */
  collectFromProviders(): void {
    this.installProviderMiddleware();
    this.installLivenessRoute();
    this.installReadinessRoute();

    for (const provider of this.app.getProviders()) {
      provider.routes?.(this.router);
    }

    this.captureRegisteredRoutes();
  }

  /**
   * Register the opt-in liveness route (default `GET /up`) when
   * `http.liveness` is configured.
   *
   * Does **no I/O**. That is the whole point. It is mounted after the
   * maintenance middleware but with its path in the maintenance `except`
   * list (see `installProviderMiddleware`), so it keeps answering `200`
   * while the app is down: an orchestrator must be able to tell a
   * down-for-maintenance app from a dead one.
   *
   * If this route ever started doing real I/O, a Redis blip would fail the
   * *liveness* probe and the orchestrator would restart every pod in the
   * deployment, turning a recoverable dependency outage into a full
   * outage plus a thundering-herd reconnect. Dependency checking belongs
   * on `/health` (see `installReadinessRoute`), which is a separate route
   * for exactly this reason.
   */
  private installLivenessRoute(): void {
    const path = this.livenessPath();

    if (!path) {
      return;
    }

    // Deliberately unnamed, as it always has been. Route names must be
    // unique or `RouteRegistry.register()` throws, so claiming one here
    // would stop an app that already names a route "liveness" from
    // booting at all, and nothing needs to reverse this path.
    this.router.get(path, () => Response.json({ status: "ok" }));
  }

  /**
   * Register the opt-in readiness route (default `GET /health`) when
   * `http.healthCheck` is configured **and** `@mahiframework/health` has bound its
   * registry.
   *
   * The dependency is inverted on purpose: `@mahiframework/health` depends on
   * `@mahiframework/core` alone, so `./artisan health` works in an app with no
   * HTTP package at all, and this package reaches it by string token,
   * exactly as it already does for `MAINTENANCE_MODE_TOKEN`. Both probes
   * are then configured in one namespace and mounted side by side, rather
   * than split across two packages' config.
   *
   * Deliberately **not** added to the maintenance `except` list: a
   * readiness probe answering "ready" while an operator has explicitly
   * taken the app down would put traffic back on it. The 503 the
   * maintenance middleware returns is the correct answer, and is already
   * the same status a check failure returns.
   */
  private installReadinessRoute(): void {
    const config = this.app.config.get<HttpConfig["healthCheck"]>("http.healthCheck");

    if (!config || !this.app.has(HEALTH_TOKEN)) {
      return;
    }

    this.router
      .get(config.path ?? "/health", async (request) => {
        // Resolved per REQUEST, not captured here. This method runs
        // during `HttpServiceProvider.boot()`, which may be before
        // `HealthServiceProvider.boot()` has collected the app's
        // `checks()` hooks, capturing the check list now would silently
        // produce an endpoint that only ever runs the built-ins.
        const registry = this.app.make<HealthRegistryLike>(HEALTH_TOKEN);
        const report = await registry.run();

        const results = shouldRedact(this.app, request, config)
          ? redactFailures(report.results)
          : report.results;

        // The global `Response`, as `installLivenessRoute` above already
        // uses, `ResponseInput` accepts either it or `HttpResponse`.
        return Response.json(results, {
          status: report.healthy ? 200 : (config.failureStatus ?? 503),
        });
      })
      // Named so `URL.route("health")` resolves it. Unlike the liveness
      // route above this is safe to name: it is new and opt-in, so an app
      // that already uses the name simply doesn't set `http.healthCheck`.
      .name("health");
  }

  private installProviderMiddleware(): void {
    const pipes: HttpPipe[] = [];

    // Open the per-request invocation scope FIRST, outermost of
    // everything, ahead of even the maintenance check, so any context
    // added by any downstream pipe or handler (current user, …) is
    // isolated to this request and can't bleed into another concurrent
    // one, and so every log line this request produces carries its
    // invocation id. This is the event that identifies a new request:
    // it assigns the id, and every log line from here on is correlatable
    // back to it. See `runInvocationScope()`.
    pipes.push((request, next) => runInvocationScope(this.app, () => next(request)));

    // Maintenance-mode check runs next, ahead of every provider pipe,
    // so a downed app short-circuits before auth/throttle/etc. It's a
    // cheap `cache.has()` per request when the app is up.
    if (this.app.has(MAINTENANCE_MODE_TOKEN)) {
      const mode = this.app.make<MaintenanceMode>(MAINTENANCE_MODE_TOKEN);
      // The LIVENESS route must stay reachable while the app is down,
      // the same exemption Laravel's own `/up` route gets, so an
      // orchestrator can tell a down-for-maintenance app from a dead one.
      //
      // The readiness route (`/health`) is deliberately NOT exempt: it
      // answers "should this instance receive traffic?", and answering
      // "yes" while an operator has explicitly taken the app down would
      // put traffic straight back on it.
      const livenessPath = this.livenessPath();
      pipes.push(maintenanceMiddleware(this.app, mode, livenessPath ? [livenessPath] : []));
    }

    for (const provider of this.app.getProviders()) {
      pipes.push(...(provider.middleware?.() ?? []));
    }

    // Filling the array the constructor already registered, rather than
    // registering a second `use("*")` here. Which would sit behind any route
    // a provider mounted onto `raw()` during its own `boot()`. See `pipes`.
    this.pipes = pipes;
  }

  private captureRegisteredRoutes(): void {
    // Hono's `routes` has one entry per handler in the chain (middleware +
    // final handler). Route-level `.middleware()` is stored on the Route
    // object rather than extra Hono handlers, so a typical route appears
    // once. Still filter Hono's synthetic "ALL" entries used for
    // middleware mounted via `use()`.
    const seen = new Set<string>();

    // Map each named route back to `METHOD path` (Hono `:param` form) so the
    // route:list command can show names alongside the captured routes.
    const namesByKey = new Map<string, string>();

    for (const [name, route] of this.registry.all()) {
      const honoPath = route.path.replace(
        /\{([A-Za-z0-9_]+)(\?)?\}/g,
        (_a, n: string, o?: string) => (o ? `:${n}?` : `:${n}`),
      );

      for (const method of route.methods) {
        namesByKey.set(`${method} ${honoPath}`, name);
      }
    }

    for (const r of this.hono.routes) {
      if (r.method === "ALL") {
        continue;
      }

      const key = `${r.method} ${r.path}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      this.routes.push({ method: r.method, path: r.path, name: namesByKey.get(key) });
    }
  }

  /** All routes registered so far, used by the `route:list` CLI command. */
  listRoutes(): RegisteredRoute[] {
    return this.routes;
  }

  /** The shared name → route registry, for the URL generator. */
  routeRegistry(): RouteRegistry {
    return this.registry;
  }

  /** The root `Router`, for the `Route` facade's static registration. */
  rootRouter(): Router {
    return this.router;
  }

  /** The raw Hono app instance, e.g. to pass into @hono/node-server's serve(). */
  raw(): Hono {
    return this.hono;
  }

  /**
   * The application's ONE websocket upgrade helper, created on first use
   * and bound to this kernel's Hono instance.
   *
   * Read `WebSocketSupport`'s docstring before adding a second source of
   * `createNodeWebSocket()` anywhere: two helpers on one Node server do
   * not conflict gracefully, they take the process down with an unhandled
   * `ERR_STREAM_WRITE_AFTER_END` on the first connection. Registering many
   * ROUTES on this one helper is the supported shape and is what every
   * consumer should do:
   *
   *   const { upgradeWebSocket } = kernel.websocketSupport();
   *   hono.get("/a", upgradeWebSocket(() => ({ ... })));
   *   hono.get("/b", upgradeWebSocket(() => ({ ... })));
   *
   * Lazily created so an app with no websocket routes never constructs a
   * `WebSocketServer`, and so `listenHttpServer()` can
   * tell "nobody asked for websockets" from "somebody did" and skip
   * attaching an `upgrade` listener in the first case.
   */
  websocketSupport(): WebSocketSupport {
    if (!this.websockets) {
      const { upgradeWebSocket, injectWebSocket, wss } = createNodeWebSocket({ app: this.hono });
      this.wss = wss;

      // Injection is wrapped to be IDEMPOTENT, and that is what makes the
      // helper safe to share. Several parties legitimately believe it is
      // their job to inject, `listenHttpServer()`, a broadcast driver
      // whose documented entrypoint snippet does it by hand, an app with
      // its own `serve()`, and there is no ordering rule that makes all
      // of them right. Attaching the `upgrade` listener twice re-creates
      // the exact two-listeners-one-socket crash this type exists to
      // prevent, so rather than legislate who calls it, the second call
      // does nothing.
      let injected = false;

      this.websockets = {
        upgradeWebSocket,
        injectWebSocket: (server) => {
          if (injected) {
            return;
          }

          injected = true;
          injectWebSocket(server);
        },
      };
    }

    return this.websockets;
  }

  /**
   * Attach the websocket upgrade handler to a running Node server, if any
   * route asked for one. Called by `listenHttpServer()` immediately after
   * `serve()` returns, because the `upgrade` event does not exist before
   * then.
   *
   * A no-op when `websocketSupport()` was never called, the difference
   * between an app with websockets and one without is a listener that is
   * never attached, not a branch at request time.
   */
  injectWebSocket(server: ServerType): void {
    this.websockets?.injectWebSocket(server);
  }

  /**
   * Close every open websocket with a normal-closure frame (1001, "going
   * away") and shut the socket server down.
   *
   * Called by `listenHttpServer()`'s `close()`, and it is what makes that
   * close actually finish. `server.close()` stops accepting *new*
   * connections and then waits for existing ones to end, and an upgraded
   * websocket never ends on its own, so a server with one connected
   * client hangs there forever. The symptom is `artisan serve` (or a
   * SIGTERM'd production server) that appears to shut down and then just
   * sits until the orchestrator SIGKILLs it.
   *
   * A no-op when no route ever asked for websockets, which is the common
   * case. `websocketSupport()` is lazy, so `wss` is undefined and there
   * is nothing to close.
   */
  closeWebSockets(): void {
    if (!this.wss) {
      return;
    }

    for (const client of this.wss.clients) {
      // 1001 "going away" is the code for a server shutting down, as
      // opposed to 1000 "normal closure" for a completed conversation.
      // It is the difference between a client that reconnects and one
      // that concludes it was told to stop.
      client.close(1001, "Server shutting down");
    }

    this.wss.close();
  }
}
