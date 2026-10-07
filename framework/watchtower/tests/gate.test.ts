import { afterEach, describe, expect, it, vi } from "vitest";
import { WatchtowerManager } from "../src/watchtower-manager.js";
import { Watchtower } from "../src/watchtower-facade.js";
import { WatchtowerServiceProvider } from "../src/watchtower-service-provider.js";
import { GateAlreadyRegisteredError } from "../src/errors.js";
import { resolveConfig } from "../src/watchtower-config.js";
import { WATCHTOWER_TOKEN } from "../src/tokens.js";
import { createHarness, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

afterEach(() => {
  harness?.cleanup();
});

function manager(): WatchtowerManager {
  return new WatchtowerManager(harness.app, resolveConfig());
}

interface TestUser {
  id: number;
  superadmin: boolean;
}

/**
 * The gate is the only thing standing between an unauthenticated request
 * and every job payload in the application, so its default matters more
 * than its behaviour.
 */
describe("the watchtower gate", () => {
  it("denies everyone when no gate is registered", async () => {
    harness = await createHarness({ migrate: false });
    const watchtower = manager();

    // The single most important assertion in the package. Installing it
    // and configuring the dashboard must grant nothing: an app that
    // forgets the gate gets a locked door, not an open one.
    expect(watchtower.hasGate()).toBe(false);
    expect(await watchtower.allows({ id: 1, superadmin: true })).toBe(false);
  });

  it("allows a user the gate accepts", async () => {
    harness = await createHarness({ migrate: false });
    const watchtower = manager();

    watchtower.gate<TestUser>((user) => user.superadmin);

    expect(await watchtower.allows({ id: 1, superadmin: true })).toBe(true);
  });

  it("denies a user the gate rejects", async () => {
    harness = await createHarness({ migrate: false });
    const watchtower = manager();

    watchtower.gate<TestUser>((user) => user.superadmin);

    expect(await watchtower.allows({ id: 2, superadmin: false })).toBe(false);
  });

  it("awaits an async gate", async () => {
    harness = await createHarness({ migrate: false });
    const watchtower = manager();

    watchtower.gate<TestUser>(async (user) => {
      await Promise.resolve();

      return user.superadmin;
    });

    expect(await watchtower.allows({ id: 1, superadmin: true })).toBe(true);
    expect(await watchtower.allows({ id: 2, superadmin: false })).toBe(false);
  });

  it("never invokes the gate for a guest", async () => {
    harness = await createHarness({ migrate: false });
    const watchtower = manager();
    const gate = vi.fn(() => true);

    watchtower.gate(gate);

    expect(await watchtower.allows(null)).toBe(false);
    expect(await watchtower.allows(undefined)).toBe(false);

    // Asserted rather than inferred from the status: the gate's `TUser`
    // is non-nullable precisely so no gate has to begin with a null
    // check, and that only holds if the guest never reaches it.
    expect(gate).not.toHaveBeenCalled();
  });

  it("treats a truthy non-boolean return as a denial", async () => {
    harness = await createHarness({ migrate: false });
    const watchtower = manager();

    // `=== true`, not truthiness. A gate that accidentally returns a
    // user object (`(user) => user.role`) would otherwise authorize
    // everyone whose role is a non-empty string.
    watchtower.gate(() => "yes" as unknown as boolean);

    expect(await watchtower.allows({ id: 1 })).toBe(false);
  });

  it("throws when a second gate is registered", async () => {
    harness = await createHarness({ migrate: false });
    const watchtower = manager();

    watchtower.gate(() => true);

    // Not last-call-wins: a stray second registration would be a
    // security change nobody reviewed, and an appending registry would
    // make the answer depend on provider order.
    expect(() => watchtower.gate(() => false)).toThrow(GateAlreadyRegisteredError);
  });

  it("keeps the first gate's decision after a rejected second registration", async () => {
    harness = await createHarness({ migrate: false });
    const watchtower = manager();

    watchtower.gate(() => true);

    try {
      watchtower.gate(() => false);
    } catch {
      // Expected.
    }

    expect(await watchtower.allows({ id: 1 })).toBe(true);
  });

  it("is reachable through the facade", async () => {
    harness = await createHarness({ migrate: false });

    harness.app.register(WatchtowerServiceProvider);
    await harness.app.bootstrap();

    // The registration path an app actually uses, from a provider's
    // boot(): `Watchtower.gate(...)` rather than resolving the manager.
    Watchtower.gate<TestUser>((user) => user.superadmin);

    expect(Watchtower.hasGate()).toBe(true);
    expect(await Watchtower.allows({ id: 1, superadmin: true })).toBe(true);
    expect(await Watchtower.allows({ id: 2, superadmin: false })).toBe(false);
  });

  it("binds one manager, so a gate registered anywhere is seen everywhere", async () => {
    harness = await createHarness({ migrate: false });

    harness.app.register(WatchtowerServiceProvider);
    await harness.app.bootstrap();

    Watchtower.gate(() => true);

    // A singleton, not a transient: a second resolution must not produce
    // a manager with no gate, which would be an open dashboard.
    expect(harness.app.make<WatchtowerManager>(WATCHTOWER_TOKEN).hasGate()).toBe(true);
  });
});
