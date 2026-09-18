import type { ServerType } from "@hono/node-server";
import type { Context, Hono } from "hono";
import type { WSContext } from "hono/ws";
import type { WebSocketSupport } from "@mahiframework/http";
import { createNodeWebSocket } from "@hono/node-ws";
import type { BroadcastDriver, BroadcastMessage } from "../broadcast-driver.js";
import type { BroadcastAuthorizer, SubscribeAuthorization } from "../broadcast-authorizer.js";
import { isPresenceChannel, isProtectedChannel } from "../channel-name.js";

/** Default path the websocket upgrade endpoint is mounted at. */
export const DEFAULT_SOCKET_PATH = "/broadcasting/socket";

/** Max distinct channels a single socket may subscribe to (memory-DoS guard). */
export const DEFAULT_MAX_SUBSCRIPTIONS_PER_SOCKET = 100;

/** Max inbound frame size in bytes before the connection is closed. */
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;

/**
 * Max unflushed outbound bytes before a socket is treated as a stuck slow
 * consumer and closed. `ws.bufferedAmount` growing without bound is a slow
 * client turning one broadcast into unbounded server memory.
 */
export const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;

/** Client -> server frames. Anything else is answered with an error frame. */
interface SubscribeFrame {
  type: "subscribe" | "unsubscribe";
  channel: string;
  /**
   * A signed subscription grant from `POST /broadcasting/auth`, for a
   * cross-origin client that can't present its session cookie on the
   * upgrade. Optional; ignored for public channels.
   */
  auth?: string;
}

/** Minimal logger the driver needs; the provider passes the app logger. */
export interface BroadcastLogger {
  error(message: string, context?: Record<string, unknown>): void;
}

export interface LocalBroadcastDriverOptions {
  /** Path the websocket upgrade endpoint is mounted at. */
  path?: string;
  /**
   * The auth seam for `private-`/`presence-` channels. When omitted, the
   * driver serves public channels only and rejects every protected channel
   * (fail closed), the pre-authorization behaviour, made explicit.
   */
  authorizer?: BroadcastAuthorizer;
  /**
   * Allowed `Origin` header values for the upgrade (cross-site websocket
   * hijacking guard). `undefined` disables the check, appropriate for
   * non-browser clients, which don't send `Origin`. When set, a browser
   * whose `Origin` isn't listed is refused the upgrade; a request with no
   * `Origin` (server-to-server) is still allowed.
   */
  allowedOrigins?: string[];
  maxSubscriptionsPerSocket?: number;
  maxFrameBytes?: number;
  maxBufferedBytes?: number;
  logger?: BroadcastLogger;
}

/** Per-connection state: who they are and what they're subscribed to. */
interface Connection {
  readonly socketId: string;
  readonly user: unknown | null;
  readonly channels: Set<string>;
}

let socketCounter = 0;
function nextSocketId(): string {
  socketCounter = (socketCounter + 1) % Number.MAX_SAFE_INTEGER;

  return `${Date.now().toString(36)}-${socketCounter.toString(36)}`;
}

/**
 * An in-process websocket broadcaster: it owns a websocket upgrade
 * endpoint mounted onto the app's *existing* Hono instance (not a second
 * server on a second port), tracks which sockets have subscribed to which
 * channels, and pushes messages to the matching ones.
 *
 * Channel authorization: `private-`/`presence-` channels are gated by the
 * `BroadcastAuthorizer` supplied in the options. The connecting user is
 * resolved once at upgrade time, and each `subscribe` to a protected
 * channel is checked against the app's `Broadcast.channel(...)` callbacks
 * (or a signed grant from `POST /broadcasting/auth`). Public channels are
 * served without any callback, exactly as before. With no authorizer at
 * all, protected channels fail closed and only public channels work.
 *
 * ---------------------------------------------------------------------
 * SINGLE-PROCESS ONLY. THIS IS NOT A CAVEAT, IT IS THE DEFINING LIMIT.
 * ---------------------------------------------------------------------
 * Subscriptions live in a `Map` in this process's memory. A broadcast
 * therefore only ever reaches clients whose websocket is connected to
 * *this* process. The moment an app runs two or more server processes,
 * two instances behind a load balancer, a `cluster`/PM2 fork setup, a
 * rolling deploy where old and new processes briefly overlap, a
 * broadcast from process A silently never reaches a client connected to
 * process B. Nothing errors; the message simply doesn't arrive, which is
 * the worst possible failure mode to discover in production.
 *
 * Use `local` when there is exactly one server process. For anything
 * horizontally scaled, the answer is a driver that fans out through
 * shared infrastructure (Redis pub/sub, Pusher, Ably) so every process
 * receives every publish and pushes to its own connected sockets:
 *
 *   manager.extend("redis", (app) => new RedisBroadcastDriver(...));
 *
 * `BroadcastManager.extend()` is the supported extension point for
 * exactly that; no such driver ships here on purpose (same "don't add
 * infrastructure dependencies speculatively" reasoning as cache/queue/
 * storage, whose defaults are likewise in-process).
 */
export class LocalBroadcastDriver implements BroadcastDriver {
  private subscriptions = new Map<string, Set<WSContext>>();
  private connections = new WeakMap<WSContext, Connection>();
  /** Presence members currently on a presence channel, per socket. */
  private presence = new Map<string, Map<WSContext, object>>();
  private injector?: (server: ServerType) => void;

  protected readonly path: string;
  protected readonly authorizer?: BroadcastAuthorizer;
  private readonly allowedOrigins?: Set<string>;
  private readonly maxSubscriptions: number;
  private readonly maxFrameBytes: number;
  private readonly maxBufferedBytes: number;
  protected readonly logger?: BroadcastLogger;

  /**
   * Accepts either a bare path (backwards-compatible with the pre-auth
   * `new LocalBroadcastDriver("/ws")` shape and `RedisBroadcastDriver`'s
   * `super(path)`) or a full options object. Passing both keeps the
   * positional `path` as the default when `options.path` is omitted.
   */
  constructor(
    pathOrOptions: string | LocalBroadcastDriverOptions = DEFAULT_SOCKET_PATH,
    options: LocalBroadcastDriverOptions = {},
  ) {
    const opts: LocalBroadcastDriverOptions =
      typeof pathOrOptions === "string" ? { path: pathOrOptions, ...options } : pathOrOptions;

    this.path = opts.path ?? DEFAULT_SOCKET_PATH;
    this.authorizer = opts.authorizer;
    this.allowedOrigins = opts.allowedOrigins ? new Set(opts.allowedOrigins) : undefined;
    this.maxSubscriptions = opts.maxSubscriptionsPerSocket ?? DEFAULT_MAX_SUBSCRIPTIONS_PER_SOCKET;
    this.maxFrameBytes = opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.maxBufferedBytes = opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.logger = opts.logger;
  }

  /**
   * Mount the websocket upgrade endpoint onto the app's Hono instance.
   *
   * `@hono/node-ws`'s `createNodeWebSocket()` must be handed the *same*
   * Hono instance the upgrade route is registered on, which is why this
   * takes the kernel's raw Hono rather than the framework's `Router`
   * facade. This is genuinely the "advanced use" escape hatch
   * `Router.raw()` exists for.
   *
   * **Pass `support` whenever there is a kernel to get it from.** An app
   * with a websocket route of its own, a PTY bridge, a collaborative
   * document, anything, must share ONE `createNodeWebSocket()` helper
   * with this driver, because two of them attached to one Node server
   * crash the process on the first connection rather than conflicting
   * politely. `HttpKernel.websocketSupport()` is that shared helper and
   * `BroadcastServiceProvider` hands it in; see `WebSocketSupport`'s
   * docstring in `@mahiframework/http` for the full mechanism.
   *
   * The fallback of building its own is kept only for a caller with a
   * bare Hono and no kernel (the driver's own tests), where by definition
   * there is no other helper to collide with. A shared helper's
   * `injectWebSocket` is idempotent, so passing one in costs this driver
   * nothing and it keeps calling injection exactly as before.
   *
   * Registering the route is only half of it: Node's HTTP server has to
   * be told to handle upgrade requests, which can only happen once
   * `serve()` has returned a server. See `injectWebSocket()`.
   *
   * The `Origin` allow-list is enforced as a pre-handler that runs during
   * the upgrade's `fetch` pass: returning a 403 there means the node-ws
   * waiter is never armed, so the upgrade is refused before any socket is
   * accepted (cross-site websocket hijacking guard).
   */
  registerRoutes(hono: Hono, support?: WebSocketSupport): void {
    const { upgradeWebSocket, injectWebSocket } = support ?? createNodeWebSocket({ app: hono });

    this.injector = injectWebSocket;

    hono.get(
      this.path,
      (c, next) => this.guardOrigin(c, next),
      upgradeWebSocket(async (c) => {
        // Resolve who this connection is authenticated as, once, at
        // upgrade time. A failure to resolve is treated as a guest rather
        // than crashing the handshake.
        const user = await this.resolveUser(c);

        return {
          onOpen: (_event, ws) => this.register(ws, user),
          onMessage: (event, ws) => this.handleMessage(event.data, ws),
          onClose: (_event, ws) => this.forget(ws),
          onError: (_event, ws) => this.forget(ws),
        };
      }),
    );
  }

  private async resolveUser(c: Context): Promise<unknown | null> {
    if (!this.authorizer) {
      return null;
    }

    try {
      return await this.authorizer.resolveUser(c);
    } catch (error) {
      this.logger?.error("Failed to resolve broadcast socket user", {
        error: error instanceof Error ? error.message : String(error),
      });

      return null;
    }
  }

  /** Refuse the upgrade when the browser `Origin` isn't allow-listed. */
  private async guardOrigin(c: Context, next: () => Promise<void>): Promise<Response | void> {
    if (!this.allowedOrigins) {
      return next();
    }

    const origin = c.req.header("Origin");

    // No Origin at all = a non-browser client, not subject to CSWSH.
    if (origin === undefined) {
      return next();
    }

    if (!this.allowedOrigins.has(origin)) {
      return c.text("Forbidden origin.", 403);
    }

    return next();
  }

  /**
   * Attach the websocket upgrade handler to a running Node server,
   * called from the app's entrypoint with `@hono/node-server`'s
   * `serve()` return value:
   *
   *   const server = serve({ fetch: kernel.raw().fetch, port });
   *   broadcaster.injectWebSocket(server);
   *
   * Without this the upgrade route is mounted but no connection ever
   * completes the handshake, so clients fail to connect while plain HTTP
   * keeps working, the exact symptom to look for if websockets appear
   * dead in an app that forgot this line.
   *
   * Safe to call even when something else has already injected, a
   * shared helper from `HttpKernel.websocketSupport()` ignores every call
   * after the first, precisely so that this line can stay in an app's
   * entrypoint without anyone having to know who else calls it.
   *
   * Still throws when `registerRoutes()` was never called at all, which
   * remains a genuine wiring bug and is the case this check exists for.
   */
  injectWebSocket(server: ServerType): void {
    if (!this.injector) {
      throw new Error("LocalBroadcastDriver.registerRoutes() must run before injectWebSocket().");
    }

    this.injector(server);
  }

  async broadcast(message: BroadcastMessage): Promise<void> {
    const frame = JSON.stringify(
      {
        channel: message.channel,
        event: message.event,
        payload: message.payload,
      },
      // A payload defaults to the event instance, which routinely holds
      // a model id — 64-bit, and so a `bigint` that `JSON.stringify`
      // throws on. A decimal string for the same reason the HTTP layer
      // uses one: a 19-digit JSON number loses precision in the browser.
      (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    );
    await this.fanoutFrame(message.channel, frame);
  }

  /**
   * The single seam every outbound frame, data broadcasts AND presence
   * control frames alike, passes through, and the ONE thing a
   * multi-process driver overrides. In the local driver it delivers the
   * pre-encoded `frame` to this process's own subscribers; in
   * `RedisBroadcastDriver` it publishes to Redis pub/sub so every process
   * runs its own `deliverLocalFrame()`. Presence works across processes
   * because its frames ride this same path.
   *
   * `excludeSocketId` skips the socket that originated the frame (a
   * presence `joining`/`leaving` isn't echoed to the actor), matched by
   * the stable per-connection id, so exclusion survives the trip through
   * another process.
   */
  protected async fanoutFrame(
    channel: string,
    frame: string,
    excludeSocketId?: string,
  ): Promise<void> {
    this.deliverLocalFrame(channel, frame, excludeSocketId);
  }

  /** Deliver a pre-encoded frame to this process's sockets on `channel`. */
  protected deliverLocalFrame(channel: string, frame: string, excludeSocketId?: string): void {
    const sockets = this.subscriptions.get(channel);

    if (!sockets || sockets.size === 0) {
      return;
    }

    for (const ws of sockets) {
      if (excludeSocketId !== undefined && this.connections.get(ws)?.socketId === excludeSocketId) {
        continue;
      }

      this.deliver(ws, frame);
    }
  }

  /** Number of sockets currently subscribed to a channel. */
  subscriberCount(channel: string): number {
    return this.subscriptions.get(channel)?.size ?? 0;
  }

  /** Channels with at least one subscriber. */
  channels(): string[] {
    return [...this.subscriptions.keys()];
  }

  /** Set up per-connection state the moment the handshake completes. */
  private register(ws: WSContext, user: unknown | null): void {
    this.connections.set(ws, { socketId: nextSocketId(), user, channels: new Set() });
  }

  private connectionFor(ws: WSContext): Connection {
    let connection = this.connections.get(ws);

    if (!connection) {
      // A message before onOpen shouldn't happen, but never let it throw.
      connection = { socketId: nextSocketId(), user: null, channels: new Set() };
      this.connections.set(ws, connection);
    }

    return connection;
  }

  /**
   * Send a frame to one socket, pruning dead sockets and closing stuck
   * slow consumers. A socket can close between the last `onClose` and this
   * send; a dead socket must never break delivery to the live ones. And a
   * client that stops reading must not turn one broadcast into unbounded
   * server memory, past `maxBufferedBytes` of unflushed output the socket
   * is closed and forgotten.
   */
  private deliver(ws: WSContext, frame: string): void {
    if (ws.readyState !== 1) {
      this.forget(ws);

      return;
    }

    const buffered = (ws.raw as { bufferedAmount?: number } | undefined)?.bufferedAmount ?? 0;

    if (buffered > this.maxBufferedBytes) {
      // 1013 = "try again later".
      try {
        ws.close(1013, "Slow consumer.");
      } catch {
        // Best-effort; forgetting is what actually reclaims memory.
      }
      this.forget(ws);

      return;
    }

    // A `send()` can throw if the socket died between the readyState check
    // and here. This runs synchronously inside the Redis subscriber's
    // message pump for `RedisBroadcastDriver`, so an escaping throw would
    // become an uncaught exception and, on Node's defaults, take the
    // process down, one bad socket must never do that. Log and drop it.
    try {
      ws.send(frame);
    } catch (error) {
      this.logger?.error("Failed to deliver a broadcast frame to a socket", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.forget(ws);
    }
  }

  private handleMessage(data: unknown, ws: WSContext): void {
    if (typeof data === "string" && Buffer.byteLength(data) > this.maxFrameBytes) {
      ws.send(JSON.stringify({ error: "Frame exceeds the maximum allowed size." }));
      try {
        ws.close(1009, "Frame too large.");
      } catch {
        // Best-effort.
      }
      this.forget(ws);

      return;
    }

    const frame = this.parseFrame(data);

    if (!frame) {
      // Answered, not fatal: a malformed frame from one client shouldn't
      // tear down a connection that may have valid subscriptions on it.
      ws.send(
        JSON.stringify({
          error: 'Expected {"type":"subscribe"|"unsubscribe","channel":"..."}.',
        }),
      );

      return;
    }

    if (frame.type === "subscribe") {
      this.detached(this.handleSubscribe(frame, ws), "Broadcast subscribe failed", frame.channel);
    } else {
      this.unsubscribe(frame.channel, ws);
      ws.send(JSON.stringify({ type: "unsubscribed", channel: frame.channel }));
    }
  }

  private async handleSubscribe(frame: SubscribeFrame, ws: WSContext): Promise<void> {
    const connection = this.connectionFor(ws);

    if (
      connection.channels.size >= this.maxSubscriptions &&
      !connection.channels.has(frame.channel)
    ) {
      ws.send(
        JSON.stringify({
          type: "subscription_error",
          channel: frame.channel,
          error: "Subscription limit reached.",
        }),
      );

      return;
    }

    let authorization: SubscribeAuthorization;
    try {
      authorization = await this.authorizeSubscription(frame, connection.user);
    } catch (error) {
      this.logger?.error("Broadcast channel authorization threw", {
        channel: frame.channel,
        error: error instanceof Error ? error.message : String(error),
      });
      ws.send(
        JSON.stringify({
          type: "subscription_error",
          channel: frame.channel,
          error: "Authorization failed.",
        }),
      );

      return;
    }

    if (!authorization.authorized) {
      ws.send(
        JSON.stringify({
          type: "subscription_error",
          channel: frame.channel,
          error: "Unauthorized.",
        }),
      );

      return;
    }

    this.subscribe(frame.channel, ws);
    ws.send(JSON.stringify({ type: "subscribed", channel: frame.channel }));

    if (isPresenceChannel(frame.channel)) {
      await this.joinPresence(frame.channel, ws, authorization.presenceData ?? {});
    }
  }

  /**
   * Decide whether a socket may subscribe: public channels are always
   * allowed; protected channels go through the authorizer, first honouring
   * a signed grant on the frame (cross-origin SPA path), then falling back
   * to the connection's resolved user against the channel callbacks.
   */
  private async authorizeSubscription(
    frame: SubscribeFrame,
    user: unknown | null,
  ): Promise<SubscribeAuthorization> {
    if (!isProtectedChannel(frame.channel)) {
      return { authorized: true };
    }

    if (!this.authorizer) {
      return { authorized: false };
    }

    if (frame.auth !== undefined && this.authorizer.verifyGrant) {
      const granted = this.authorizer.verifyGrant(frame.channel, frame.auth);

      if (granted) {
        return granted;
      }
    }

    return this.authorizer.authorize(frame.channel, user);
  }

  private parseFrame(data: unknown): SubscribeFrame | null {
    if (typeof data !== "string") {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return null;
    }

    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    const { type, channel, auth } = parsed as Partial<SubscribeFrame>;

    if (type !== "subscribe" && type !== "unsubscribe") {
      return null;
    }

    if (typeof channel !== "string" || channel === "") {
      return null;
    }

    if (auth !== undefined && typeof auth !== "string") {
      return null;
    }

    return { type, channel, auth };
  }

  private subscribe(channel: string, ws: WSContext): void {
    const sockets = this.subscriptions.get(channel) ?? new Set<WSContext>();
    sockets.add(ws);
    this.subscriptions.set(channel, sockets);
    this.connectionFor(ws).channels.add(channel);
  }

  /**
   * Run a socket-driven task without awaiting it, but never let its
   * rejection escape. These fire from `onMessage`/`onClose` handlers with no
   * caller to await them, and a presence roster or fanout backed by a
   * remote store (Redis) can fail, most commonly during shutdown, when
   * sockets close after the store has already disconnected. An unhandled
   * rejection there would crash the process on Node's defaults.
   */
  private detached(task: Promise<void>, message: string, channel: string): void {
    task.catch((error: unknown) => {
      this.logger?.error(message, {
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private unsubscribe(channel: string, ws: WSContext): void {
    if (isPresenceChannel(channel)) {
      this.detached(this.leavePresence(channel, ws), "Broadcast presence leave failed", channel);
    }

    const sockets = this.subscriptions.get(channel);
    this.connections.get(ws)?.channels.delete(channel);

    if (!sockets) {
      return;
    }

    sockets.delete(ws);

    if (sockets.size === 0) {
      this.subscriptions.delete(channel);
    }
  }

  // Membership is tracked here in-process. `RedisBroadcastDriver` overrides
  // the async roster seams below (`presenceMembers`/`presenceAdd`/
  // `presenceRemove`) so a presence channel's roster is shared across every
  // process via a Redis set; the `here`/`joining`/`leaving` frames ride the
  // same `fanoutFrame()` path as data broadcasts, so they already reach
  // every process. The local driver's in-memory maps are correct for the
  // single-process case this class serves.

  private async joinPresence(channel: string, ws: WSContext, member: object): Promise<void> {
    const socketId = this.connectionFor(ws).socketId;

    // Snapshot the roster BEFORE adding this socket, so `here` lists the
    // existing members plus this one exactly once. Drop this socket's own
    // prior entry from the snapshot: a re-subscribe (allowed. See the
    // subscription-limit check) overwrites the roster slot, and without
    // this the old entry AND the appended `member` both appeared.
    const existing = (await this.presenceMembers(channel)).filter((m) => m.socketId !== socketId);
    await this.presenceAdd(channel, ws, socketId, member);

    // The joining socket gets the full current roster (including itself)...
    ws.send(
      JSON.stringify({
        type: "presence:here",
        channel,
        members: [...existing.map((m) => m.member), member],
      }),
    );

    // ...and everyone else on the channel (this process or another) is
    // told about the newcomer, but not the newcomer itself.
    await this.fanoutFrame(
      channel,
      JSON.stringify({ type: "presence:joining", channel, member }),
      socketId,
    );
  }

  private async leavePresence(channel: string, ws: WSContext): Promise<void> {
    const socketId = this.connections.get(ws)?.socketId;
    const member = await this.presenceRemove(channel, ws, socketId);

    if (member === undefined) {
      return;
    }

    await this.fanoutFrame(
      channel,
      JSON.stringify({ type: "presence:leaving", channel, member }),
      socketId,
    );
  }

  /** Current members on a presence channel (overridable for shared stores). */
  protected async presenceMembers(
    channel: string,
  ): Promise<Array<{ socketId: string; member: object }>> {
    const roster = this.presence.get(channel);

    if (!roster) {
      return [];
    }

    return [...roster.entries()].map(([ws, member]) => ({
      socketId: this.connectionFor(ws).socketId,
      member,
    }));
  }

  protected async presenceAdd(
    channel: string,
    ws: WSContext,
    _socketId: string,
    member: object,
  ): Promise<void> {
    const roster = this.presence.get(channel) ?? new Map<WSContext, object>();
    roster.set(ws, member);
    this.presence.set(channel, roster);
  }

  /** Remove a socket from a presence channel; returns its member info, if any. */
  protected async presenceRemove(
    channel: string,
    ws: WSContext,
    _socketId?: string,
  ): Promise<object | undefined> {
    const roster = this.presence.get(channel);

    if (!roster) {
      return undefined;
    }

    const member = roster.get(ws);
    roster.delete(ws);

    if (roster.size === 0) {
      this.presence.delete(channel);
    }

    return member;
  }

  /**
   * Drop a socket from every channel it subscribed to. Without this the
   * `subscriptions` map would grow forever as clients come and go,
   * a slow memory leak that only shows up under real traffic. Presence
   * channels additionally publish a `leaving` frame to the survivors.
   */
  private forget(ws: WSContext): void {
    const connection = this.connections.get(ws);
    const channels = connection ? [...connection.channels] : [...this.subscriptions.keys()];

    for (const channel of channels) {
      this.unsubscribe(channel, ws);
    }

    // Belt-and-braces: if we had no per-connection record, sweep every set.
    if (!connection) {
      for (const [channel, sockets] of this.subscriptions) {
        sockets.delete(ws);

        if (sockets.size === 0) {
          this.subscriptions.delete(channel);
        }
      }
    }

    this.connections.delete(ws);
  }
}
