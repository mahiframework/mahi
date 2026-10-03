import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearCurrentApp } from "@mahiframework/core";
import { ImpersonationDeniedError } from "../src/errors.js";
import {
  captureError,
  Client,
  createHarness,
  makeUser,
  type Harness,
  type UserAttributes,
} from "./__fixtures__/test-app.js";

/**
 * The gate, the hooks, and the chain rules. Driven over real HTTP where a
 * request is needed, because `start()`/`stop()` are inseparable from the
 * session cookie they rewrite.
 */
describe("ImpersonationManager", () => {
  let harness: Harness;
  let bob: UserAttributes;
  let alice: UserAttributes;

  beforeEach(async () => {
    harness = await createHarness({ impersonation: { routes: {} } });
    bob = await makeUser("bob", true);
    alice = await makeUser("alice");
  });

  afterEach(() => clearCurrentApp());

  describe("the default gate", () => {
    it("denies everything until authorize() is called", async () => {
      // Fail-closed, asserted first. Installing the package must grant
      // nobody anything; a package that shipped an allow-all default
      // would be a privilege-escalation bug in every app that added it
      // before writing its gate.
      expect(harness.impersonation.hasGate()).toBe(false);
      expect(await harness.impersonation.canImpersonate(bob, alice)).toBe(false);

      await expect(harness.impersonation.assertCanImpersonate(bob, alice)).rejects.toThrow(
        ImpersonationDeniedError,
      );
    });

    it("names the missing gate in the error, rather than just saying forbidden", async () => {
      const error = await captureError<ImpersonationDeniedError>(
        harness.impersonation.assertCanImpersonate(bob, alice),
      );

      expect(error.reason).toBe("not-authorized");
      expect(error.message).toContain("Impersonation.authorize");
    });
  });

  describe("authorize()", () => {
    it("REPLACES the previous gate rather than appending", async () => {
      // The surprising half of the API, pinned. An appending registry
      // would make "who may impersonate" depend on provider order.
      harness.impersonation.authorize(() => true);
      harness.impersonation.authorize(() => false);

      expect(await harness.impersonation.canImpersonate(bob, alice)).toBe(false);
    });

    it("passes both users through, in (admin, target) order", async () => {
      const seen: Array<[string, string]> = [];

      harness.impersonation.authorize<UserAttributes>((admin, user) => {
        seen.push([admin.id, user.id]);

        return true;
      });

      await harness.impersonation.canImpersonate(bob, alice);

      expect(seen).toEqual([["bob", "alice"]]);
    });

    it("supports the superadmin shape from the docs", async () => {
      harness.impersonation.authorize<UserAttributes>(
        (admin, user) => admin.superadmin === 1 && user.superadmin !== 1,
      );

      expect(await harness.impersonation.canImpersonate(bob, alice)).toBe(true);
      // Alice is not a superadmin, so she may not impersonate anyone.
      expect(await harness.impersonation.canImpersonate(alice, bob)).toBe(false);

      // And a superadmin may not impersonate another superadmin.
      const carol = await makeUser("carol", true);
      expect(await harness.impersonation.canImpersonate(bob, carol)).toBe(false);
    });

    it("awaits an async gate", async () => {
      harness.impersonation.authorize(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));

        return true;
      });

      expect(await harness.impersonation.canImpersonate(bob, alice)).toBe(true);
    });
  });

  describe("self-impersonation", () => {
    it("is denied before the gate is even consulted", async () => {
      let consulted = false;
      harness.impersonation.authorize(() => {
        consulted = true;

        return true;
      });

      const error = await captureError<ImpersonationDeniedError>(
        harness.impersonation.assertCanImpersonate(bob, bob),
      );

      expect(error.reason).toBe("self");
      expect(consulted).toBe(false);
    });

    it("is denied by canImpersonate() too", async () => {
      harness.impersonation.authorize(() => true);

      expect(await harness.impersonation.canImpersonate(bob, bob)).toBe(false);
    });
  });

  describe("before() hooks", () => {
    it("run in registration order, after the gate", async () => {
      const order: string[] = [];

      harness.impersonation.authorize(() => {
        order.push("gate");

        return true;
      });
      harness.impersonation.before(() => void order.push("first"));
      harness.impersonation.before(() => void order.push("second"));

      await harness.impersonation.assertCanImpersonate(bob, alice);

      expect(order).toEqual(["gate", "first", "second"]);
    });

    it("do not run when the gate already denied", async () => {
      let ran = false;
      harness.impersonation.authorize(() => false);
      harness.impersonation.before(() => void (ran = true));

      await expect(harness.impersonation.assertCanImpersonate(bob, alice)).rejects.toThrow(
        ImpersonationDeniedError,
      );

      // A refused request must not have prompted for MFA on the way to
      // being refused.
      expect(ran).toBe(false);
    });

    it("deny by throwing, and the thrown error propagates UNWRAPPED", async () => {
      // The reason `before()` takes a throwing callback at all: an
      // existing guard drops in with no adapter, and its own error, which
      // may carry a 401 and a challenge header, must reach the client as
      // itself rather than being flattened into a 403.
      class MfaRequired extends Error {}

      harness.impersonation.authorize(() => true);
      harness.impersonation.before(() => {
        throw new MfaRequired("Verify to continue.");
      });

      await expect(harness.impersonation.assertCanImpersonate(bob, alice)).rejects.toThrow(
        MfaRequired,
      );
    });

    it("deny on a literal `false` return", async () => {
      // `void` accepts a boolean-returning arrow under TypeScript's
      // assignability rules, so `before((a, u) => cond)` compiles. If the
      // runtime ignored the value, that reads as a working check and
      // allows everything. Pinned so a future simplification can't
      // quietly reopen it.
      harness.impersonation.authorize(() => true);
      harness.impersonation.before(() => false);

      const error = await captureError<ImpersonationDeniedError>(
        harness.impersonation.assertCanImpersonate(bob, alice),
      );

      expect(error).toBeInstanceOf(ImpersonationDeniedError);
      expect(error.reason).toBe("not-authorized");
    });

    it("allow on any other return value, including undefined and true", async () => {
      harness.impersonation.authorize(() => true);
      harness.impersonation.before(() => undefined);
      harness.impersonation.before(() => true);

      await expect(harness.impersonation.assertCanImpersonate(bob, alice)).resolves.toBeUndefined();
    });

    it("are NOT run by canImpersonate()", async () => {
      // The split exists because hooks are side-effecting: an MFA hook
      // prompts. A predicate used to render a disabled button must be
      // safe to call, so it cannot run them.
      let ran = false;
      harness.impersonation.authorize(() => true);
      harness.impersonation.before(() => void (ran = true));

      expect(await harness.impersonation.canImpersonate(bob, alice)).toBe(true);
      expect(ran).toBe(false);
    });
  });

  describe("start() and stop()", () => {
    beforeEach(() => {
      harness.impersonation.authorize<UserAttributes>((admin) => admin.superadmin === 1);
    });

    it("swaps the authenticated user, then swaps it back", async () => {
      const client = new Client(harness);

      await client.json("/login", { method: "POST", body: JSON.stringify({ id: "bob" }) });
      await expect(whoami(client)).resolves.toMatchObject({
        user: { id: "bob" },
        impersonating: false,
      });

      const started = await client.send("/impersonate/alice", { method: "POST" });
      expect(started.status).toBe(200);

      // The assertion the whole package exists for: the NEXT request,
      // carrying only the cookie, is Alice.
      await expect(whoami(client)).resolves.toMatchObject({
        user: { id: "alice" },
        impersonating: true,
        depth: 1,
        impersonator: "bob",
      });

      const stopped = await client.send("/impersonate", { method: "DELETE" });
      expect(stopped.status).toBe(200);

      await expect(whoami(client)).resolves.toMatchObject({
        user: { id: "bob" },
        impersonating: false,
      });
    });

    it("authenticates as the target for the REST of the starting request", async () => {
      // `SessionGuard.login()` republishes the ambient auth scope, so a
      // controller that starts an impersonation and then renders the user
      // sees the new one without re-fetching.
      const client = new Client(harness);
      await client.json("/login", { method: "POST", body: JSON.stringify({ id: "bob" }) });

      const response = await client.send("/impersonate/alice", { method: "POST" });

      expect((await response.json()) as unknown).toMatchObject({
        impersonating: "alice",
        impersonator: "bob",
        depth: 1,
      });
    });

    it("404s on an unknown target rather than 403", async () => {
      // "No such user" is not an authorization failure.
      const client = new Client(harness);
      await client.json("/login", { method: "POST", body: JSON.stringify({ id: "bob" }) });

      const response = await client.send("/impersonate/nobody", { method: "POST" });

      expect(response.status).toBe(404);
    });

    it("403s when the gate denies", async () => {
      const client = new Client(harness);
      await client.json("/login", { method: "POST", body: JSON.stringify({ id: "alice" }) });

      // Alice is not a superadmin.
      const response = await client.send("/impersonate/bob", { method: "POST" });

      expect(response.status).toBe(403);
    });

    it("409s when stopping without an active impersonation", async () => {
      const client = new Client(harness);
      await client.json("/login", { method: "POST", body: JSON.stringify({ id: "bob" }) });

      const response = await client.send("/impersonate", { method: "DELETE" });

      expect(response.status).toBe(409);
    });

    it("stop() returns null (not a throw) at the manager level when idle", async () => {
      const client = new Client(harness);
      await client.json("/login", { method: "POST", body: JSON.stringify({ id: "bob" }) });

      // The 409 above is the controller's choice; the manager itself
      // reports "nothing to do" so a hand-rolled route can decide.
      const response = await client.send("/me");
      expect(response.status).toBe(200);
    });

    it("leaves the impersonated user's own sessions alone", async () => {
      // Impersonating someone must not log them out of their own devices.
      const victim = new Client(harness);
      await victim.json("/login", { method: "POST", body: JSON.stringify({ id: "alice" }) });

      const admin = new Client(harness);
      await admin.json("/login", { method: "POST", body: JSON.stringify({ id: "bob" }) });
      await admin.send("/impersonate/alice", { method: "POST" });

      await expect(whoami(victim)).resolves.toMatchObject({
        user: { id: "alice" },
        impersonating: false,
      });
    });

    it("stops successfully even when the gate would now deny", async () => {
      // The no-trap property. An admin whose access is revoked
      // mid-impersonation must still be able to get out; possession of
      // the row is the authorization for leaving.
      const client = new Client(harness);
      await client.json("/login", { method: "POST", body: JSON.stringify({ id: "bob" }) });
      await client.send("/impersonate/alice", { method: "POST" });

      harness.impersonation.authorize(() => false);

      const stopped = await client.send("/impersonate", { method: "DELETE" });

      expect(stopped.status).toBe(200);
      await expect(whoami(client)).resolves.toMatchObject({ user: { id: "bob" } });
    });
  });

  describe("chain depth", () => {
    beforeEach(() => {
      harness.impersonation.authorize(() => true);
    });

    it("denies a second link at the default maxDepth of 1", async () => {
      const client = await impersonatingClient();

      const response = await client.send("/impersonate/jane", { method: "POST" });

      expect(response.status).toBe(403);
    });

    it("denies impersonating someone already in the chain", async () => {
      const client = await impersonatingClient();

      // Alice is currently being impersonated; Bob is doing it. Neither
      // may be the next target, or "stop" would walk back into a user who
      // is simultaneously further up the chain.
      const response = await client.send("/impersonate/bob", { method: "POST" });

      expect(response.status).toBe(403);
    });

    it("treats maxDepth <= 0 as 1 rather than as disabled", async () => {
      // A configured 0 can only mean "nobody may impersonate", which is
      // the default gate's job. Honouring it would make a typo present as
      // impersonation inexplicably never working.
      for (const maxDepth of [0, -1]) {
        const h = await createHarness({ impersonation: { routes: {}, maxDepth } });
        h.impersonation.authorize(() => true);
        await makeUser("bob", true);
        await makeUser("alice");
        await makeUser("jane");

        const client = new Client(h);
        await client.json("/login", { method: "POST", body: JSON.stringify({ id: "bob" }) });

        // One link still works...
        expect((await client.send("/impersonate/alice", { method: "POST" })).status).toBe(200);
        // ...and a second is still refused.
        expect((await client.send("/impersonate/jane", { method: "POST" })).status).toBe(403);
      }
    });

    it("allows nesting at maxDepth 2, and unwinds one link at a time", async () => {
      const h = await createHarness({ impersonation: { routes: {}, maxDepth: 2 } });
      h.impersonation.authorize(() => true);
      await makeUser("bob", true);
      await makeUser("alice");
      await makeUser("jane");

      const client = new Client(h);
      await client.json("/login", { method: "POST", body: JSON.stringify({ id: "bob" }) });
      await client.send("/impersonate/alice", { method: "POST" });

      const nested = await client.send("/impersonate/jane", { method: "POST" });
      expect(nested.status).toBe(200);

      await expect(whoami(client)).resolves.toMatchObject({
        user: { id: "jane" },
        depth: 2,
        // The innermost link was started BY Alice...
        impersonator: "alice",
        // ...but the real human at the top is still Bob.
        root: "bob",
      });

      // First stop unwinds to Alice, not all the way to Bob. The parent
      // row takes over the newly minted session.
      await client.send("/impersonate", { method: "DELETE" });
      await expect(whoami(client)).resolves.toMatchObject({
        user: { id: "alice" },
        impersonating: true,
        depth: 1,
        impersonator: "bob",
        root: "bob",
      });

      await client.send("/impersonate", { method: "DELETE" });
      await expect(whoami(client)).resolves.toMatchObject({
        user: { id: "bob" },
        impersonating: false,
      });
    });

    it("denies a third link at maxDepth 2", async () => {
      const h = await createHarness({ impersonation: { routes: {}, maxDepth: 2 } });
      h.impersonation.authorize(() => true);
      await makeUser("bob", true);
      await makeUser("alice");
      await makeUser("jane");
      await makeUser("kim");

      const client = new Client(h);
      await client.json("/login", { method: "POST", body: JSON.stringify({ id: "bob" }) });
      await client.send("/impersonate/alice", { method: "POST" });
      await client.send("/impersonate/jane", { method: "POST" });

      expect((await client.send("/impersonate/kim", { method: "POST" })).status).toBe(403);
    });
  });

  /** Log Bob in and have him impersonate Alice. Jane exists but is idle. */
  async function impersonatingClient(): Promise<Client> {
    await makeUser("jane");

    const client = new Client(harness);
    await client.json("/login", { method: "POST", body: JSON.stringify({ id: "bob" }) });
    await client.send("/impersonate/alice", { method: "POST" });

    return client;
  }

  async function whoami(client: Client): Promise<unknown> {
    const response = await client.send("/me");

    return response.json();
  }
});
