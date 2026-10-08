import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "hono";
import type { WSContext } from "hono/ws";
import { LocalBroadcastDriver } from "../src/drivers/local-broadcast-driver.js";
import type { BroadcastAuthorizer, SubscribeAuthorization } from "../src/broadcast-authorizer.js";
import {
  startTestServer,
  TestSocket,
  waitUntil,
  type TestServer,
} from "./websocket-test-helpers.js";

/** Authorizes any presence channel, using `?user=` as the member's id. */
class PresenceAuthorizer implements BroadcastAuthorizer {
  resolveUser(context: Context): string | null {
    return new URL(context.req.url).searchParams.get("user");
  }

  async authorize(_channel: string, user: unknown): Promise<SubscribeAuthorization> {
    if (typeof user !== "string") {
      return { authorized: false };
    }

    return { authorized: true, presenceData: { id: user } };
  }
}

describe("LocalBroadcastDriver presence channels", () => {
  let server: TestServer | undefined;
  const sockets: TestSocket[] = [];

  async function boot(): Promise<{ driver: LocalBroadcastDriver; port: number }> {
    const driver = new LocalBroadcastDriver({ authorizer: new PresenceAuthorizer() });
    server = await startTestServer(driver);

    return { driver, port: server.port };
  }

  async function connect(port: number, user: string): Promise<TestSocket> {
    const socket = await TestSocket.connect(port, `/broadcasting/socket?user=${user}`);
    sockets.push(socket);

    return socket;
  }

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
  });

  it("sends the current roster (here) to a joining member", async () => {
    const { port } = await boot();
    const alice = await connect(port, "alice");

    alice.send({ type: "subscribe", channel: "presence-chat.general" });
    expect(await alice.nextMessage()).toMatchObject({ type: "subscribed" });
    expect(await alice.nextMessage()).toEqual({
      type: "presence:here",
      channel: "presence-chat.general",
      members: [{ id: "alice" }],
    });
  });

  it("lists a re-subscribing socket once in `here`, not twice", async () => {
    const { port } = await boot();
    const alice = await connect(port, "alice");

    alice.send({ type: "subscribe", channel: "presence-chat.general" });
    await alice.nextMessage(); // subscribed
    await alice.nextMessage(); // here

    // Subscribing again overwrites this socket's roster slot; the roster
    // snapshot must not still carry the old entry alongside the new one.
    alice.send({ type: "subscribe", channel: "presence-chat.general" });
    await alice.nextMessage(); // subscribed
    expect(await alice.nextMessage()).toEqual({
      type: "presence:here",
      channel: "presence-chat.general",
      members: [{ id: "alice" }],
    });
  });

  it("notifies existing members when someone joins, without echoing to the joiner", async () => {
    const { port } = await boot();

    const alice = await connect(port, "alice");
    alice.send({ type: "subscribe", channel: "presence-chat.general" });
    await alice.nextMessage(); // subscribed
    await alice.nextMessage(); // here

    const bob = await connect(port, "bob");
    bob.send({ type: "subscribe", channel: "presence-chat.general" });
    await bob.nextMessage(); // subscribed
    expect(await bob.nextMessage()).toMatchObject({
      type: "presence:here",
      members: expect.arrayContaining([{ id: "alice" }, { id: "bob" }]),
    });

    // Alice hears bob joining; bob does not hear his own join.
    expect(await alice.nextMessage()).toEqual({
      type: "presence:joining",
      channel: "presence-chat.general",
      member: { id: "bob" },
    });
  });

  it("notifies remaining members when someone leaves (disconnect)", async () => {
    const { driver, port } = await boot();

    const alice = await connect(port, "alice");
    alice.send({ type: "subscribe", channel: "presence-chat.general" });
    await alice.nextMessage();
    await alice.nextMessage();

    const bob = await connect(port, "bob");
    bob.send({ type: "subscribe", channel: "presence-chat.general" });
    await bob.nextMessage();
    await bob.nextMessage();
    await alice.nextMessage(); // joining bob

    await bob.close();

    expect(await alice.nextMessage()).toEqual({
      type: "presence:leaving",
      channel: "presence-chat.general",
      member: { id: "bob" },
    });
    await waitUntil(() => driver.subscriberCount("presence-chat.general") === 1);
  });

  it("notifies remaining members when someone unsubscribes explicitly", async () => {
    const { port } = await boot();

    const alice = await connect(port, "alice");
    alice.send({ type: "subscribe", channel: "presence-chat.general" });
    await alice.nextMessage();
    await alice.nextMessage();

    const bob = await connect(port, "bob");
    bob.send({ type: "subscribe", channel: "presence-chat.general" });
    await bob.nextMessage();
    await bob.nextMessage();
    await alice.nextMessage(); // joining bob

    bob.send({ type: "unsubscribe", channel: "presence-chat.general" });
    expect(await bob.nextMessage()).toMatchObject({ type: "unsubscribed" });

    expect(await alice.nextMessage()).toEqual({
      type: "presence:leaving",
      channel: "presence-chat.general",
      member: { id: "bob" },
    });
  });
});

/**
 * `presence:here` must reach a joining socket before any roster delta for
 * that channel. A `joining`/`leaving` ahead of it describes a change to a
 * roster the client hasn't received, so it has nothing to apply the delta
 * to and ends up with a member list missing (or double-counting) whoever
 * moved during the handshake.
 *
 * The window is the `await` in `joinPresence()`: a shared roster store
 * (Redis) takes a round trip or two to read the roster and add the member,
 * and the socket is already subscribed for fan-out by then. Stalling the
 * roster write holds that window open deliberately, so a race that is
 * otherwise rare and load-dependent reproduces every run.
 */
describe("LocalBroadcastDriver presence handshake ordering", () => {
  let server: TestServer | undefined;
  const sockets: TestSocket[] = [];

  /**
   * Holds one member's roster write open until the test releases it.
   * Stalling by member id rather than globally matters: every join reads
   * the roster, so a blanket gate would also block the very joins whose
   * deltas are supposed to arrive during the window.
   */
  class StallingRosterDriver extends LocalBroadcastDriver {
    private stalledMember?: string;
    private release?: () => void;
    private gate?: Promise<void>;

    stall(memberId: string): void {
      this.stalledMember = memberId;
      this.gate = new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }

    resume(): void {
      this.stalledMember = undefined;
      this.release?.();
    }

    protected override async presenceAdd(
      channel: string,
      ws: WSContext,
      socketId: string,
      member: object,
    ): Promise<void> {
      await super.presenceAdd(channel, ws, socketId, member);

      if ((member as { id?: string }).id === this.stalledMember) {
        await this.gate;
      }
    }
  }

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
  });

  it("delivers presence:here before a roster delta that lands mid-handshake", async () => {
    const driver = new StallingRosterDriver({ authorizer: new PresenceAuthorizer() });
    server = await startTestServer(driver);

    const alice = await TestSocket.connect(server.port, "/broadcasting/socket?user=alice");
    sockets.push(alice);
    alice.send({ type: "subscribe", channel: "presence-chat.general" });
    await alice.nextMessage(); // subscribed
    await alice.nextMessage(); // here

    // Bob's roster read is now stuck, so his socket is subscribed for
    // fan-out while his `here` is still pending: exactly the window.
    driver.stall("bob");
    const bob = await TestSocket.connect(server.port, "/broadcasting/socket?user=bob");
    sockets.push(bob);
    bob.send({ type: "subscribe", channel: "presence-chat.general" });
    expect(await bob.nextMessage()).toMatchObject({ type: "subscribed" });

    // A third member joins inside bob's window, so its delta is published
    // while he is still waiting for `here`.
    const carol = await TestSocket.connect(server.port, "/broadcasting/socket?user=carol");
    sockets.push(carol);
    carol.send({ type: "subscribe", channel: "presence-chat.general" });
    await waitUntil(() => driver.subscriberCount("presence-chat.general") === 3);
    await alice.nextMessage(); // joining carol, proving the delta is out

    driver.resume();

    // `here` first, then the buffered deltas in the order they happened.
    const here = await bob.nextMessage();
    expect(here).toMatchObject({ type: "presence:here" });
    expect(here.members).toEqual(expect.arrayContaining([{ id: "alice" }, { id: "bob" }]));
    expect(await bob.nextMessage()).toMatchObject({
      type: "presence:joining",
      member: { id: "carol" },
    });
  });

  it("drops the buffered deltas when the socket unsubscribes before its here lands", async () => {
    const driver = new StallingRosterDriver({ authorizer: new PresenceAuthorizer() });
    server = await startTestServer(driver);

    const alice = await TestSocket.connect(server.port, "/broadcasting/socket?user=alice");
    sockets.push(alice);
    alice.send({ type: "subscribe", channel: "presence-chat.general" });
    await alice.nextMessage();
    await alice.nextMessage();

    driver.stall("bob");
    const bob = await TestSocket.connect(server.port, "/broadcasting/socket?user=bob");
    sockets.push(bob);
    bob.send({ type: "subscribe", channel: "presence-chat.general" });
    expect(await bob.nextMessage()).toMatchObject({ type: "subscribed" });

    // Carol's join queues a delta behind bob's pending `here`...
    const carol = await TestSocket.connect(server.port, "/broadcasting/socket?user=carol");
    sockets.push(carol);
    carol.send({ type: "subscribe", channel: "presence-chat.general" });
    await waitUntil(() => driver.subscriberCount("presence-chat.general") === 3);

    // ...and then bob leaves, so that delta is for a channel he no longer
    // has and must be dropped rather than flushed after the fact.
    bob.send({ type: "unsubscribe", channel: "presence-chat.general" });
    expect(await bob.nextMessage()).toMatchObject({ type: "unsubscribed" });

    driver.resume();

    expect(await bob.nextMessage()).toMatchObject({ type: "presence:here" });
    await bob.expectNoMessage();
  });
});

describe("LocalBroadcastDriver presence store failures", () => {
  let server: TestServer | undefined;
  const sockets: TestSocket[] = [];

  /** A driver whose roster store fails, as a remote (Redis) store does once disconnected. */
  class FailingRosterDriver extends LocalBroadcastDriver {
    protected override async presenceRemove(): Promise<object | undefined> {
      throw new Error("Connection is closed.");
    }

    protected override async presenceAdd(): Promise<void> {
      throw new Error("Connection is closed.");
    }
  }

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
  });

  it("logs, rather than leaks as an unhandled rejection, when a socket leaves and the roster store fails", async () => {
    const errors: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const driver = new FailingRosterDriver({
      authorizer: new PresenceAuthorizer(),
      logger: { error: (message, context) => errors.push({ message, context }) },
    });
    server = await startTestServer(driver);

    const alice = await TestSocket.connect(server.port, "/broadcasting/socket?user=alice");
    sockets.push(alice);

    alice.send({ type: "subscribe", channel: "presence-chat.general" });
    expect(await alice.nextMessage()).toMatchObject({ type: "subscribed" });

    await waitUntil(() => errors.some((e) => e.message === "Broadcast subscribe failed"));
    expect(errors[0]!.context).toEqual({
      channel: "presence-chat.general",
      error: "Connection is closed.",
    });

    await alice.close();

    await waitUntil(() => errors.some((e) => e.message === "Broadcast presence leave failed"));
    await waitUntil(() => driver.subscriberCount("presence-chat.general") === 0);
  });
});
