import {
  ServiceProvider,
  BROADCAST_TOKEN,
  SIGNER_TOKEN,
  afterCommit,
  type Application,
} from "@mahiframework/core";
import { EVENTS_TOKEN, type EventDispatcher } from "@mahiframework/events";
import {
  HTTP_KERNEL_TOKEN,
  HttpResponse,
  type HttpKernel,
  type Request,
  type Router,
} from "@mahiframework/http";
import { BroadcastManager, type BroadcastConfig } from "./broadcast-manager.js";
import {
  LocalBroadcastDriver,
  DEFAULT_SOCKET_PATH,
  type LocalBroadcastDriverOptions,
} from "./drivers/local-broadcast-driver.js";
import {
  broadcastMessageFor,
  shouldBroadcast,
  shouldBroadcastAfterCommit,
} from "./should-broadcast.js";
import { ChannelRegistry } from "./channel-registry.js";
import { ContainerBroadcastAuthorizer, type SignerLike } from "./container-authorizer.js";
import { isPresenceChannel, isProtectedChannel } from "./channel-name.js";

import "./provider-hooks.js";

// Canonical definition in `@mahiframework/core`'s `well-known-tokens`
// (resolved cross-package by `@mahiframework/http`'s `listen.ts`);
// re-exported so this package's public API is unchanged.
export { BROADCAST_TOKEN };

/** The container token the shared `ChannelRegistry` singleton is bound under. */
export const CHANNEL_REGISTRY_TOKEN = "broadcast.channels";

/** How long a `POST /broadcasting/auth` grant is valid, in ms. */
const GRANT_TTL_MS = 60_000;

export interface LocalConnectionConfig {
  /** Path the websocket upgrade endpoint is mounted at. */
  path?: string;
}

/**
 * Channel-authorization + hardening options shared by every websocket
 * broadcast driver, read from the `broadcasting` config.
 *
 *   auth: {
 *     guards?: string[];        // guards tried at upgrade (default ["session","token"])
 *     allowedOrigins?: string[];// Origin allow-list (default: none = allow all)
 *     maxSubscriptionsPerSocket?: number;
 *     maxFrameBytes?: number;
 *     maxBufferedBytes?: number;
 *   }
 */
export interface BroadcastAuthConfig {
  guards?: string[];
  allowedOrigins?: string[];
  maxSubscriptionsPerSocket?: number;
  maxFrameBytes?: number;
  maxBufferedBytes?: number;
}

interface BroadcastConfigWithAuth extends BroadcastConfig {
  auth?: BroadcastAuthConfig;
}

/**
 * Build the `LocalBroadcastDriverOptions` every websocket driver shares,
 * authorizer, origin allow-list, limits, logger, from the app's
 * `broadcasting` config. Exported so `@mahiframework/redis`'s `RedisBroadcastDriver`
 * gets identical authorization/hardening without re-deriving any of it.
 */
export function resolveBroadcastDriverOptions(
  app: Application,
  path: string = DEFAULT_SOCKET_PATH,
): LocalBroadcastDriverOptions {
  const config = app.config.get<BroadcastConfigWithAuth>("broadcasting", {
    default: "local",
    connections: {},
  });
  const auth = config.auth ?? {};

  // The registry is normally bound by `BroadcastServiceProvider.register()`;
  // fall back to a fresh empty one for a test/app that wired the manager by
  // hand (protected channels then simply fail closed, which is correct).
  const registry = app.has(CHANNEL_REGISTRY_TOKEN)
    ? app.make<ChannelRegistry>(CHANNEL_REGISTRY_TOKEN)
    : new ChannelRegistry();
  // Resolved lazily: constructing the signer requires APP_KEY, and boot must
  // succeed without one so `key:generate` can run on a fresh app.
  const signer = (): SignerLike | undefined =>
    app.has(SIGNER_TOKEN) ? app.make<SignerLike>(SIGNER_TOKEN) : undefined;
  const guards = auth.guards ?? ["session", "token"];

  const authorizer = new ContainerBroadcastAuthorizer(app, registry, guards, signer);

  return {
    path,
    authorizer,
    allowedOrigins: auth.allowedOrigins,
    maxSubscriptionsPerSocket: auth.maxSubscriptionsPerSocket,
    maxFrameBytes: auth.maxFrameBytes,
    maxBufferedBytes: auth.maxBufferedBytes,
    logger: app.logger,
  };
}

/**
 * Registers the `BroadcastManager` singleton with the built-in `"local"`
 * driver, mounts that driver's websocket endpoint onto the existing
 * `HttpKernel`, wires channel authorization, and decorates the app's
 * `EventDispatcher` so any event implementing `ShouldBroadcast` is
 * forwarded to connected clients.
 *
 * Ordering in `config/app.ts`'s `providers[]`. Both are hard
 * requirements, since both tokens are resolved in this provider's own
 * `boot()`:
 *   - after `EventsServiceProvider` (needs `EVENTS_TOKEN`)
 *   - after `HttpServiceProvider` (needs `HTTP_KERNEL_TOKEN`, and wants
 *     the kernel's global middleware already installed so the websocket
 *     route is mounted behind it)
 *
 * Channel authorization: `private-`/`presence-` channels are gated by the
 * `Broadcast.channel(...)` callbacks providers declare in their
 * `channels()` hook. A same-origin browser authenticates the upgrade with
 * its session cookie; a cross-origin SPA calls `POST /broadcasting/auth`
 * to obtain a short-lived signed grant it presents on the subscribe frame.
 *
 * Read `LocalBroadcastDriver`'s docstring before deploying anything using
 * the `"local"` driver: it only delivers to clients connected to the same
 * process that broadcasts, which makes it wrong for any multi-process or
 * multi-instance deployment.
 */
export class BroadcastServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(CHANNEL_REGISTRY_TOKEN, () => new ChannelRegistry());

    this.app.singleton(BROADCAST_TOKEN, (app) => {
      const config = app.config.require<BroadcastConfig>("broadcasting");
      const manager = new BroadcastManager(app, config);

      manager.extend("local", (resolveApp) => {
        const local = (manager.connectionConfig("local") ?? {}) as LocalConnectionConfig;
        const path = local.path ?? DEFAULT_SOCKET_PATH;

        return new LocalBroadcastDriver(resolveBroadcastDriverOptions(resolveApp, path));
      });

      return manager;
    });
  }

  boot(): void {
    const broadcaster = this.app.make<BroadcastManager>(BROADCAST_TOKEN);

    // Collect channel-authorization callbacks BEFORE the driver is
    // resolved in registerSocketRoutes(), so the authorizer it captures
    // sees a fully-populated registry.
    this.collectChannelCallbacks();

    this.registerSocketRoutes(broadcaster);
    this.registerAuthEndpoint(broadcaster);
    this.forwardBroadcastableEvents(broadcaster);
  }

  /**
   * Gather every provider's `channels()` declarations into the shared
   * `ChannelRegistry`, exactly as `HttpKernel` gathers `routes()`.
   */
  private collectChannelCallbacks(): void {
    const registry = this.app.make<ChannelRegistry>(CHANNEL_REGISTRY_TOKEN);

    for (const provider of this.app.getProviders()) {
      provider.channels?.(registry);
    }
  }

  /**
   * Mounts the driver's websocket endpoint onto the kernel's own Hono
   * instance, one server, one port, no second listener. Only drivers
   * that actually have routes to register (i.e. `local`) do anything
   * here.
   *
   * The kernel's `websocketSupport()` is passed in rather than letting the
   * driver build its own, so that an application adding a websocket route
   * of its own shares this one helper. Two `createNodeWebSocket()` helpers
   * on a single Node server crash the process on the first connection.
   * See `WebSocketSupport` in `@mahiframework/http`.
   */
  private registerSocketRoutes(broadcaster: BroadcastManager): void {
    const driver = broadcaster.connection();

    if (!(driver instanceof LocalBroadcastDriver)) {
      return;
    }

    const kernel = this.app.make<HttpKernel>(HTTP_KERNEL_TOKEN);
    driver.registerRoutes(kernel.raw(), kernel.websocketSupport());
  }

  /**
   * The `POST /broadcasting/auth` endpoint (Laravel Echo's default): a
   * cross-origin SPA whose browser won't send the session cookie on the
   * websocket upgrade instead authenticates a normal same-origin XHR here
   * (cookie IS sent), and receives a short-lived signed grant to present
   * on its `subscribe` frame's `auth` field.
   *
   * Registered on the kernel's raw Hono directly (like the socket route)
   * so it participates in the global pipe chain, including the auth scope,
   * even though it's mounted from a provider `boot()`.
   */
  private registerAuthEndpoint(broadcaster: BroadcastManager): void {
    const driver = broadcaster.connection();

    if (!(driver instanceof LocalBroadcastDriver)) {
      return;
    }

    const authorizer = new ContainerBroadcastAuthorizer(
      this.app,
      this.app.make<ChannelRegistry>(CHANNEL_REGISTRY_TOKEN),
      this.broadcastGuards(),
      () => (this.app.has(SIGNER_TOKEN) ? this.app.make<SignerLike>(SIGNER_TOKEN) : undefined),
    );

    const kernel = this.app.make<HttpKernel>(HTTP_KERNEL_TOKEN);
    const router = kernel.rootRouter() as Router;

    router.post("/broadcasting/auth", async (request: Request) => {
      const channel = request.input("channel");

      if (typeof channel !== "string" || channel === "") {
        return HttpResponse.json({ error: "A channel is required." }, 422);
      }

      // Public channels need no grant.
      if (!isProtectedChannel(channel)) {
        return HttpResponse.json({ auth: null });
      }

      const context = request.raw();

      if (!context) {
        return HttpResponse.json({ error: "Unauthorized." }, 403);
      }

      const user = await authorizer.resolveUser(context);
      const decision = await authorizer.authorize(channel, user);

      if (!decision.authorized) {
        return HttpResponse.json({ error: "Unauthorized." }, 403);
      }

      const presenceData = isPresenceChannel(channel) ? decision.presenceData : undefined;
      const grant = authorizer.mintGrant(channel, GRANT_TTL_MS, presenceData);

      return HttpResponse.json({
        auth: grant,
        ...(presenceData ? { channel_data: presenceData } : {}),
      });
    });
  }

  private broadcastGuards(): string[] {
    const config = this.app.config.get<BroadcastConfigWithAuth>("broadcasting");

    return config?.auth?.guards ?? ["session", "token"];
  }

  /**
   * The whole "opt in from the event class, change nothing at the dispatch
   * call site" mechanism, in one place: every dispatched event is checked
   * for the `ShouldBroadcast` marker, and forwarded if it has it.
   *
   * Broadcasting is deliberately **fire-and-forget with logged errors**,
   * not awaited inside `dispatch()`. A websocket push is a side channel:
   * a slow or failing broadcast must never delay, or fail, the
   * application logic that dispatched the event in the first place. A
   * `TodoCreated` listener writing to the database should not roll back
   * because a client's socket had a bad day. The trade-off, stated
   * plainly: `await dispatch(...)` returning does **not** guarantee the
   * broadcast has been flushed to clients yet, and a failed broadcast
   * surfaces only in the log.
   */
  private forwardBroadcastableEvents(broadcaster: BroadcastManager): void {
    const dispatcher = this.app.make<EventDispatcher>(EVENTS_TOKEN);
    const logger = this.app.logger;

    dispatcher.afterDispatch((event) => {
      if (!shouldBroadcast(event)) {
        return;
      }

      const message = broadcastMessageFor(event);

      const push = (): void => {
        void broadcaster.broadcast(message).catch((error: unknown) => {
          logger.error("Failed to broadcast event", {
            event: message.event,
            channel: message.channel,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      };

      // An event marked `ShouldBroadcastAfterCommit` holds its broadcast
      // until the enclosing `DB.transaction()` commits (dropped on
      // rollback); otherwise it fires now. `afterCommit()` runs the
      // callback immediately when no transaction is open, so the message
      // is resolved (`broadcastMessageFor`) at dispatch time either way.
      // Fire-and-forget as before, a slow/failed broadcast must never
      // delay or fail the dispatch.
      if (shouldBroadcastAfterCommit(event)) {
        void afterCommit(push);
      } else {
        push();
      }
    });
  }
}
