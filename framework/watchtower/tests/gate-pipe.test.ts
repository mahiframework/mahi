import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_TOKEN } from "@mahiframework/core";
import { HttpError } from "@mahiframework/http";
import type { Request } from "@mahiframework/http";
import { watchtowerGate } from "../src/http/gate.js";
import { Watchtower } from "../src/watchtower-facade.js";
import { WatchtowerServiceProvider } from "../src/watchtower-service-provider.js";
import { createHarness, captureError, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

afterEach(() => {
  harness?.cleanup();
});

interface TestUser {
  id: number;
  superadmin: boolean;
}

/** Bind an auth manager resolving to `user`, or omit it entirely. */
async function boot(user?: TestUser | null): Promise<Harness> {
  harness = await createHarness({ migrate: false });
  harness.app.config.set("watchtower", { dashboard: {} });

  if (user !== undefined) {
    harness.app.instance(AUTH_TOKEN, { userOrNull: () => user });
  }

  harness.app.register(WatchtowerServiceProvider);
  await harness.app.bootstrap();

  return harness;
}

const request = {} as Request;
const next = vi.fn(async () => "passed" as never);

/** The pipe returns `ResponseInput | Promise<…>`; always await it. */
function run(): Promise<unknown> {
  return Promise.resolve(watchtowerGate()(request, next));
}

/**
 * The pipe is the only thing between an unauthenticated request and every
 * job payload in the application, so its default matters more than its
 * behaviour.
 */
describe("watchtowerGate", () => {
  it("refuses an authenticated user when no gate is registered", async () => {
    await boot({ id: 1, superadmin: true });

    // The most important assertion here: a superadmin is refused, because
    // nothing said who is allowed. Installing the package and configuring
    // the dashboard grants nothing.
    const error = await captureError(run());

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(403);
  });

  it("warns, once, about the missing gate", async () => {
    await boot({ id: 1, superadmin: true });
    const warning = vi.fn();
    harness.app.logger.warning = warning as never;

    await captureError(run());

    // The response must not reveal WHY it refused, but an operator
    // locked out of their own dashboard needs to know.
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("no gate is registered"));
  });

  it("passes a user the gate accepts", async () => {
    await boot({ id: 1, superadmin: true });
    Watchtower.gate<TestUser>((user) => user.superadmin);

    const result = await run();

    expect(result).toBe("passed");
  });

  it("refuses a user the gate rejects", async () => {
    await boot({ id: 2, superadmin: false });
    Watchtower.gate<TestUser>((user) => user.superadmin);

    expect(await captureError(run())).toBeInstanceOf(HttpError);
  });

  it("refuses a guest with 403, not 401", async () => {
    await boot(null);
    Watchtower.gate<TestUser>((user) => user.superadmin);

    const error = (await captureError(run())) as HttpError;

    // 401 is not an authorization decision. A route that wants "log in"
    // says so by carrying `authenticate()` ahead of this pipe.
    expect(error.status).toBe(403);
  });

  it("never invokes the gate for a guest", async () => {
    await boot(null);
    const gate = vi.fn(() => true);
    Watchtower.gate(gate);

    await captureError(run());

    // `TUser` is non-nullable precisely so no gate has to begin with a
    // null check, and that only holds if the guest never reaches it.
    expect(gate).not.toHaveBeenCalled();
  });

  it("refuses when auth is not bound at all", async () => {
    await boot();
    Watchtower.gate(() => true);

    // An app with no authentication cannot identify anyone, so nobody is
    // authorized. Deny rather than throw, because the pipe's job is to
    // answer allow/deny.
    expect(await captureError(run())).toBeInstanceOf(HttpError);
  });

  it("gives the same 403 whichever way it refused", async () => {
    const statuses: number[] = [];

    for (const [user, gate] of [
      [{ id: 1, superadmin: true }, undefined],
      [{ id: 2, superadmin: false }, (u: TestUser) => u.superadmin],
      [null, (u: TestUser) => u.superadmin],
    ] as const) {
      harness?.cleanup();
      await boot(user as TestUser | null);

      if (gate) {
        Watchtower.gate(gate);
      }

      const error = (await captureError(run())) as HttpError;
      statuses.push(error.status);
    }

    // No gate, gate said no, and nobody authenticated must be
    // indistinguishable from outside: which one it was is useful to an
    // attacker and useless to a legitimate user.
    expect(statuses).toEqual([403, 403, 403]);
  });
});
