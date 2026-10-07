import { afterEach, describe, expect, it } from "vitest";
import { Application } from "../src/application.js";
import { Invocation } from "../src/invocation.js";
import { INVOCATION_CONTEXT_KEY, runInvocationScope } from "../src/invocation-scope.js";
import { formatLogLine } from "../src/logger.js";

/** RFC 9562 UUIDv7: version nibble 7, RFC 4122 variant. */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  Invocation.reset();
});

describe("Invocation", () => {
  it("generates a UUIDv7 on first call", () => {
    expect(Invocation.id()).toMatch(UUID_V7);
  });

  it("memoizes the id across calls", () => {
    const first = Invocation.id();

    expect(Invocation.id()).toBe(first);
    expect(Invocation.id()).toBe(first);
  });

  it("generates a fresh id after reset()", () => {
    const first = Invocation.id();
    Invocation.reset();

    expect(Invocation.id()).not.toBe(first);
  });

  it("current() reports the memoized id without generating one", () => {
    expect(Invocation.current()).toBeNull();

    const id = Invocation.id();
    expect(Invocation.current()).toBe(id);

    Invocation.reset();
    expect(Invocation.current()).toBeNull();
  });

  it("ids are time-ordered across millisecond boundaries", async () => {
    const first = Invocation.id();
    // Within one millisecond v7 ordering is arbitrary by design (the
    // tail is entropy), so cross a boundary to assert the timestamp
    // prefix advances.
    await new Promise((resolve) => setTimeout(resolve, 2));
    Invocation.reset();
    const second = Invocation.id();

    expect(second > first).toBe(true);
  });

  it("needs no configuration or provider to work", () => {
    // The whole point of UUIDv7 here: no container, no Application, no
    // registered provider, no worker id to get wrong.
    expect(Invocation.id()).toMatch(UUID_V7);
  });

  describe("per-invocation isolation", () => {
    it("gives each scope its own id, and leaves the global holder alone", () => {
      expect(Invocation.hasScope()).toBe(false);

      const a = Invocation.runScoped(() => Invocation.id());
      const b = Invocation.runScoped(() => Invocation.id());

      expect(a).not.toBe(b);
      // The global holder never generated one of its own.
      expect(Invocation.current()).toBeNull();
    });

    it("reports an active scope only inside one", () => {
      Invocation.runScoped(() => {
        expect(Invocation.hasScope()).toBe(true);
      });

      expect(Invocation.hasScope()).toBe(false);
    });

    it("a reset() inside a scope does not disturb a concurrent scope", async () => {
      // Two interleaved async scopes. The point is that `reset()` in one
      // must not be observable in the other: a plain static field would
      // fail this, and that is the bug the AsyncLocalStorage backing
      // exists to prevent.
      const slow = Invocation.runScoped(async () => {
        const before = Invocation.id();
        await new Promise((resolve) => setTimeout(resolve, 10));

        return { before, after: Invocation.id() };
      });

      const fast = Invocation.runScoped(async () => {
        const id = Invocation.id();
        Invocation.reset();

        return { id, afterReset: Invocation.id() };
      });

      const [slowResult, fastResult] = await Promise.all([slow, fast]);

      // The slow scope's id survived the fast scope's reset untouched.
      expect(slowResult.after).toBe(slowResult.before);
      expect(fastResult.afterReset).not.toBe(fastResult.id);
      expect(slowResult.before).not.toBe(fastResult.id);
    });

    it("1000 concurrent invocations all get distinct ids", async () => {
      const ids = await Promise.all(
        Array.from({ length: 1000 }, () =>
          Invocation.runScoped(async () => {
            await Promise.resolve();

            return Invocation.id();
          }),
        ),
      );

      expect(new Set(ids).size).toBe(1000);
    });
  });
});

describe("runInvocationScope", () => {
  it("publishes the invocation id into the context for log lines", () => {
    const app = new Application();

    runInvocationScope(app, () => {
      expect(app.context.get(INVOCATION_CONTEXT_KEY)).toBe(Invocation.id());
      expect(app.context.get<string>(INVOCATION_CONTEXT_KEY)).toMatch(UUID_V7);
    });
  });

  it("puts the invocation id on every formatted log line", () => {
    const app = new Application();

    const [id, line] = runInvocationScope(app, () => [
      Invocation.id(),
      formatLogLine("info", "handling request", undefined, app),
    ]);

    expect(line).toContain(`{"invocation":"${id}"}`);

    // Outside the invocation there is no id in the context, so the
    // formatter omits the key rather than inventing one.
    expect(formatLogLine("info", "booting", undefined, app)).not.toContain("invocation");
  });

  it("discards context the invocation added when it ends", () => {
    const app = new Application();

    runInvocationScope(app, () => {
      app.context.add("jobName", "SendInvoice");
    });

    // Neither the invocation id nor anything the invocation added leaks
    // into the process-global store — the leak a long-lived queue worker
    // would otherwise accumulate.
    expect(app.context.has(INVOCATION_CONTEXT_KEY)).toBe(false);
    expect(app.context.has("jobName")).toBe(false);
  });

  it("gives successive invocations distinct ids", () => {
    const app = new Application();

    const first = runInvocationScope(app, () => app.context.get(INVOCATION_CONTEXT_KEY));
    const second = runInvocationScope(app, () => app.context.get(INVOCATION_CONTEXT_KEY));

    expect(first).not.toBe(second);
  });

  it("opens a container resolution scope so scoped() bindings resolve once", () => {
    const app = new Application();

    let built = 0;
    app.scoped("per-invocation", () => ({ n: ++built }));

    runInvocationScope(app, () => {
      const a = app.make<{ n: number }>("per-invocation");
      const b = app.make<{ n: number }>("per-invocation");
      expect(a).toBe(b);
    });

    runInvocationScope(app, () => {
      app.make("per-invocation");
    });

    expect(built).toBe(2);
  });

  it("returns the callback's value, and propagates a throw", () => {
    const app = new Application();

    expect(runInvocationScope(app, () => "ok")).toBe("ok");
    expect(() =>
      runInvocationScope(app, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
  });

  it("keeps the id stable across await boundaries inside one invocation", async () => {
    const app = new Application();

    await runInvocationScope(app, async () => {
      const before = Invocation.id();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(Invocation.id()).toBe(before);
      expect(app.context.get(INVOCATION_CONTEXT_KEY)).toBe(before);
    });
  });
});
