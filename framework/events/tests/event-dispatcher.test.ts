import { Application, setAfterCommitResolver, clearAfterCommitResolver } from "@mahiframework/core";
import { afterEach, describe, expect, it } from "vitest";
import { AbstractEvent } from "../src/event.js";
import type { Listener } from "../src/listener.js";
import { EventDispatcher, type QueuedListenerPayload } from "../src/event-dispatcher.js";

class UserRegistered extends AbstractEvent {
  constructor(public readonly email: string) {
    super();
  }
}

class OtherEvent extends AbstractEvent {}

describe("EventDispatcher", () => {
  it("dispatches an event only to listeners registered for its class", async () => {
    const handled: string[] = [];

    class SendWelcomeEmail implements Listener<UserRegistered> {
      handle(event: UserRegistered) {
        handled.push(`welcome:${event.email}`);
      }
    }

    class ShouldNotRun implements Listener<OtherEvent> {
      handle() {
        handled.push("should-not-run");
      }
    }

    const app = new Application();
    const dispatcher = new EventDispatcher(app);
    dispatcher.listen(UserRegistered, SendWelcomeEmail);
    dispatcher.listen(OtherEvent, ShouldNotRun);

    await dispatcher.dispatch(new UserRegistered("a@example.com"));

    expect(handled).toEqual(["welcome:a@example.com"]);
  });

  it("runs multiple listeners for the same event, in registration order", async () => {
    const handled: string[] = [];

    class First implements Listener<UserRegistered> {
      handle() {
        handled.push("first");
      }
    }

    class Second implements Listener<UserRegistered> {
      handle() {
        handled.push("second");
      }
    }

    const app = new Application();
    const dispatcher = new EventDispatcher(app);
    dispatcher.listen(UserRegistered, First);
    dispatcher.listen(UserRegistered, Second);

    await dispatcher.dispatch(new UserRegistered("a@example.com"));

    expect(handled).toEqual(["first", "second"]);
  });

  it("awaits async listener handlers before dispatch() resolves", async () => {
    const handled: string[] = [];

    class Slow implements Listener<UserRegistered> {
      async handle() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        handled.push("slow-done");
      }
    }

    const app = new Application();
    const dispatcher = new EventDispatcher(app);
    dispatcher.listen(UserRegistered, Slow);

    await dispatcher.dispatch(new UserRegistered("a@example.com"));

    expect(handled).toEqual(["slow-done"]);
  });

  it("constructs each listener with the Application, so listeners can pull their own deps", async () => {
    let receivedApp: Application | undefined;

    class Inspecting implements Listener<UserRegistered> {
      constructor(app: Application) {
        receivedApp = app;
      }
      handle() {}
    }

    const app = new Application();
    const dispatcher = new EventDispatcher(app);
    dispatcher.listen(UserRegistered, Inspecting);

    await dispatcher.dispatch(new UserRegistered("a@example.com"));

    expect(receivedApp).toBe(app);
  });

  it("does nothing when an event has no registered listeners", async () => {
    const app = new Application();
    const dispatcher = new EventDispatcher(app);

    await expect(dispatcher.dispatch(new OtherEvent())).resolves.toBeUndefined();
  });

  describe("afterDispatch()", () => {
    it("runs the callback for every dispatched event, whatever its class", async () => {
      const seen: string[] = [];

      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.afterDispatch((event) => {
        seen.push(event.constructor.name);
      });

      await dispatcher.dispatch(new UserRegistered("a@example.com"));
      await dispatcher.dispatch(new OtherEvent());

      expect(seen).toEqual(["UserRegistered", "OtherEvent"]);
    });

    it("runs callbacks after every listener has finished, in registration order", async () => {
      const order: string[] = [];

      class Slow implements Listener<UserRegistered> {
        async handle() {
          await new Promise((resolve) => setTimeout(resolve, 10));
          order.push("listener");
        }
      }

      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.listen(UserRegistered, Slow);
      dispatcher.afterDispatch(() => {
        order.push("after-one");
      });
      dispatcher.afterDispatch(() => {
        order.push("after-two");
      });

      await dispatcher.dispatch(new UserRegistered("a@example.com"));

      expect(order).toEqual(["listener", "after-one", "after-two"]);
    });

    it("awaits async callbacks before dispatch() resolves", async () => {
      const seen: string[] = [];

      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.afterDispatch(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        seen.push("slow-after");
      });

      await dispatcher.dispatch(new UserRegistered("a@example.com"));

      expect(seen).toEqual(["slow-after"]);
    });

    it("runs even when the event has no registered listeners", async () => {
      let ran = false;

      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.afterDispatch(() => {
        ran = true;
      });

      await dispatcher.dispatch(new OtherEvent());

      expect(ran).toBe(true);
    });

    it("propagates a throwing callback to the dispatch() caller", async () => {
      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.afterDispatch(() => {
        throw new Error("after-dispatch boom");
      });

      await expect(dispatcher.dispatch(new OtherEvent())).rejects.toThrow("after-dispatch boom");
    });
  });

  describe("wildcard listen()", () => {
    class PostCreated extends AbstractEvent {
      get eventName(): string {
        return "model.posts.created";
      }
      constructor(public readonly postId: string) {
        super();
      }
    }

    it("dispatches to a pattern listener matching event.eventName", async () => {
      const seen: string[] = [];
      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.listen("model.posts.*", (event) => {
        seen.push(`${event.eventName}:${(event as PostCreated).postId}`);
      });
      dispatcher.listen("model.comments.*", () => {
        seen.push("should-not-run");
      });

      await dispatcher.dispatch(new PostCreated("p1"));

      expect(seen).toEqual(["model.posts.created:p1"]);
    });

    it("runs wildcard listeners in registration order relative to class listeners", async () => {
      const order: string[] = [];

      class ClassListener implements Listener<PostCreated> {
        handle() {
          order.push("class");
        }
      }

      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.listen("model.*", () => {
        order.push("wild-first");
      });
      dispatcher.listen(PostCreated, ClassListener);
      dispatcher.listen("model.posts.*", () => {
        order.push("wild-last");
      });

      await dispatcher.dispatch(new PostCreated("p1"));

      expect(order).toEqual(["wild-first", "class", "wild-last"]);
    });

    it("dispatches to a listener CLASS registered against a pattern", async () => {
      const seen: string[] = [];

      class AuditModelWrites implements Listener {
        handle(event: AbstractEvent) {
          seen.push(event.eventName);
        }
      }

      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.listen("model.posts.*", AuditModelWrites);
      dispatcher.listen("model.comments.*", AuditModelWrites);

      await dispatcher.dispatch(new PostCreated("p1"));

      expect(seen).toEqual(["model.posts.created"]);
    });

    it("constructs a pattern listener class fresh per dispatch, with the app", async () => {
      const constructed: Array<Application | undefined> = [];

      class CountingListener implements Listener {
        constructor(app: Application) {
          constructed.push(app);
        }
        handle() {}
      }

      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.listen("*", CountingListener);

      await dispatcher.dispatch(new PostCreated("p1"));
      await dispatcher.dispatch(new PostCreated("p2"));

      expect(constructed).toEqual([app, app]);
    });

    it("interleaves pattern listener classes with everything else in registration order", async () => {
      const order: string[] = [];

      class WildClass implements Listener {
        handle() {
          order.push("wild-class");
        }
      }
      class EventClassListener implements Listener<PostCreated> {
        handle() {
          order.push("event-class");
        }
      }

      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.listen("model.*", WildClass);
      dispatcher.listen(PostCreated, EventClassListener);
      dispatcher.listen("model.posts.*", () => {
        order.push("wild-closure");
      });

      await dispatcher.dispatch(new PostCreated("p1"));

      expect(order).toEqual(["wild-class", "event-class", "wild-closure"]);
    });

    it("propagates a throwing pattern listener class and skips later listeners", async () => {
      const order: string[] = [];

      class Exploding implements Listener {
        handle(): void {
          throw new Error("wildcard boom");
        }
      }

      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.listen("model.*", Exploding);
      dispatcher.listen("model.*", () => {
        order.push("never");
      });

      await expect(dispatcher.dispatch(new PostCreated("p1"))).rejects.toThrow("wildcard boom");
      expect(order).toEqual([]);
    });
  });

  describe("listenQueued()", () => {
    it("enqueues via the bound handler instead of running the listener inline", async () => {
      const payloads: QueuedListenerPayload[] = [];
      const handled: string[] = [];

      class SendWelcome implements Listener<UserRegistered> {
        handle(event: UserRegistered) {
          handled.push(event.email);
        }
      }

      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.useQueuedListenerHandler((payload) => {
        payloads.push(payload);
      });
      dispatcher.listenQueued(UserRegistered, SendWelcome);

      await dispatcher.dispatch(new UserRegistered("a@example.com"));

      expect(handled).toEqual([]);
      expect(payloads).toHaveLength(1);
      expect(payloads[0]?.data).toMatchObject({ email: "a@example.com" });

      await dispatcher.runQueuedListener(payloads[0]!);
      expect(handled).toEqual(["a@example.com"]);
    });

    it("throws at dispatch time when no queued-listener handler is bound", async () => {
      class SendWelcome implements Listener<UserRegistered> {
        handle() {}
      }

      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.listenQueued(UserRegistered, SendWelcome);

      await expect(dispatcher.dispatch(new UserRegistered("a@example.com"))).rejects.toThrow(
        "No queued-listener handler is bound",
      );
    });
  });

  describe("closure listeners on class events", () => {
    it("runs a closure registered against an event class", async () => {
      const seen: string[] = [];
      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.listen(UserRegistered, (event) => {
        seen.push(event.email);
      });

      await dispatcher.dispatch(new UserRegistered("a@example.com"));
      expect(seen).toEqual(["a@example.com"]);
    });

    it("does not run a closure for a different event class", async () => {
      const seen: string[] = [];
      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.listen(UserRegistered, () => {
        seen.push("ran");
      });

      await dispatcher.dispatch(new OtherEvent());
      expect(seen).toEqual([]);
    });
  });

  describe("abstract base classes as matchers", () => {
    // `listen()` never constructs the class it is given, it only tests
    // dispatched events against it with `instanceof`. Requiring a concrete
    // constructor for a key that is never called broke the documented
    // "observe everything" pattern, and with it the useful shape for an
    // audit log: one registration on a family base rather than an explicit
    // list that silently misses whichever subclass is added next.
    abstract class DomainEvent extends AbstractEvent {}
    class OrderPlaced extends DomainEvent {}
    class OrderShipped extends DomainEvent {}

    it("catches every subclass through an abstract base", async () => {
      const seen: string[] = [];
      const dispatcher = new EventDispatcher(new Application());
      dispatcher.listen(DomainEvent, (event) => {
        seen.push(event.eventName);
      });

      await dispatcher.dispatch(new OrderPlaced());
      await dispatcher.dispatch(new OrderShipped());

      expect(seen).toEqual(["OrderPlaced", "OrderShipped"]);
    });

    it("catches everything through AbstractEvent itself", async () => {
      const seen: string[] = [];
      const dispatcher = new EventDispatcher(new Application());
      dispatcher.listen(AbstractEvent, (event) => {
        seen.push(event.eventName);
      });

      await dispatcher.dispatch(new OrderPlaced());
      await dispatcher.dispatch(new UserRegistered("a@example.com"));

      expect(seen).toEqual(["OrderPlaced", "UserRegistered"]);
    });

    it("does not catch an unrelated event through an abstract base", async () => {
      const seen: string[] = [];
      const dispatcher = new EventDispatcher(new Application());
      dispatcher.listen(DomainEvent, () => {
        seen.push("ran");
      });

      await dispatcher.dispatch(new UserRegistered("a@example.com"));

      expect(seen).toEqual([]);
    });

    it("accepts a listener class against an abstract base", async () => {
      const seen: string[] = [];

      class RecordDomainEvent implements Listener<DomainEvent> {
        handle(event: DomainEvent) {
          seen.push(event.eventName);
        }
      }

      const dispatcher = new EventDispatcher(new Application());
      dispatcher.listen(DomainEvent, RecordDomainEvent);

      await dispatcher.dispatch(new OrderShipped());

      expect(seen).toEqual(["OrderShipped"]);
    });
  });

  describe("stable event names", () => {
    it("dispatches two same-named classes in different modules independently", async () => {
      // Simulate two modules that each declare a `Created` event; a stable
      // `static eventName` disambiguates them.
      class CreatedA extends AbstractEvent {
        static override eventName = "moduleA.Created";
      }
      class CreatedB extends AbstractEvent {
        static override eventName = "moduleB.Created";
      }

      const seen: string[] = [];
      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.listen(CreatedA, () => {
        seen.push("A");
      });
      dispatcher.listen(CreatedB, () => {
        seen.push("B");
      });

      await dispatcher.dispatch(new CreatedA());
      expect(seen).toEqual(["A"]);
    });

    it("keys queued-listener ids by the stable event/listener names", async () => {
      class OrderPlaced extends AbstractEvent {
        static override eventName = "billing.OrderPlaced";
      }
      class NotifyWarehouse implements Listener<OrderPlaced> {
        static listenerName = "warehouse.Notify";
        handle() {}
      }

      const payloads: QueuedListenerPayload[] = [];
      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.useQueuedListenerHandler((p) => {
        payloads.push(p);
      });
      dispatcher.listenQueued(OrderPlaced, NotifyWarehouse as never);

      await dispatcher.dispatch(new OrderPlaced());
      expect(payloads[0]?.id).toBe("billing.OrderPlaced:warehouse.Notify");
    });
  });

  describe("after-commit dispatch", () => {
    afterEach(() => clearAfterCommitResolver());

    /** A fake transaction: captures deferred callbacks instead of running them. */
    function fakeTransaction(): { drain: () => Promise<void> } {
      const deferred: Array<() => void | Promise<void>> = [];
      setAfterCommitResolver({
        run: async (cb) => void deferred.push(cb),
        active: () => true,
      });

      return {
        drain: async () => {
          for (const cb of deferred) {
            await cb();
          }
        },
      };
    }

    class OrderPlaced extends AbstractEvent {
      static shouldDispatchAfterCommit = true;
      constructor(public readonly id: string) {
        super();
      }
    }

    it("holds a shouldDispatchAfterCommit event's listeners until commit", async () => {
      const handled: string[] = [];
      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.listen(
        OrderPlaced,
        class {
          handle(e: OrderPlaced) {
            handled.push(e.id);
          }
        } as never,
      );

      const trx = fakeTransaction();
      await dispatcher.dispatch(new OrderPlaced("1"));

      // Nothing ran yet. The dispatch is deferred.
      expect(handled).toEqual([]);

      await trx.drain();
      expect(handled).toEqual(["1"]);
    });

    it("dispatches immediately when no transaction is open", async () => {
      const handled: string[] = [];
      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.listen(
        OrderPlaced,
        class {
          handle(e: OrderPlaced) {
            handled.push(e.id);
          }
        } as never,
      );

      await dispatcher.dispatch(new OrderPlaced("1"));
      expect(handled).toEqual(["1"]);
    });

    it("dispatchAfterCommit() defers even an unmarked event", async () => {
      class PlainEvent extends AbstractEvent {}
      const handled: string[] = [];
      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.listen(
        PlainEvent,
        class {
          handle() {
            handled.push("ran");
          }
        } as never,
      );

      const trx = fakeTransaction();
      await dispatcher.dispatchAfterCommit(new PlainEvent());
      expect(handled).toEqual([]);

      await trx.drain();
      expect(handled).toEqual(["ran"]);
    });

    it("a suppressed after-commit event is never delivered even after commit", async () => {
      const handled: string[] = [];
      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.listen(
        OrderPlaced,
        class {
          handle() {
            handled.push("ran");
          }
        } as never,
      );

      const trx = fakeTransaction();
      await AbstractEvent.suppress(async () => {
        await dispatcher.dispatch(new OrderPlaced("1"));
      });
      await trx.drain();
      expect(handled).toEqual([]);
    });
  });
});
