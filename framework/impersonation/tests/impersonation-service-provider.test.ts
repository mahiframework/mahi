import { afterEach, describe, expect, it } from "vitest";
import { clearCurrentApp } from "@mahiframework/core";
import { ImpersonationManager } from "../src/impersonation-manager.js";
import { ImpersonationServiceProvider } from "../src/impersonation-service-provider.js";
import { ImpersonationGcCommand } from "../src/commands/impersonation-gc.js";
import { IMPERSONATION_TOKEN } from "../src/tokens.js";
import { Client, createHarness, makeUser } from "./__fixtures__/test-app.js";

describe("ImpersonationServiceProvider", () => {
  afterEach(() => clearCurrentApp());

  it("binds the manager whether or not any config exists", async () => {
    const harness = await createHarness();

    expect(harness.app.make<ImpersonationManager>(IMPERSONATION_TOKEN)).toBeInstanceOf(
      ImpersonationManager,
    );
  });

  describe("route registration", () => {
    it("registers NO routes when `impersonation.routes` is unset", async () => {
      // The requirement that drives the key-presence switch: an app that
      // wants its own HTTP surface takes the manager and nothing else.
      const harness = await createHarness();
      harness.impersonation.authorize(() => true);
      await makeUser("bob", true);
      await makeUser("alice");

      const client = new Client(harness);
      await client.json("/login", { method: "POST", body: JSON.stringify({ id: "bob" }) });

      expect((await client.send("/impersonate/alice", { method: "POST" })).status).toBe(404);
      expect((await client.send("/impersonate", { method: "DELETE" })).status).toBe(404);
    });

    it("registers them when it is present but empty", async () => {
      const harness = await createHarness({ impersonation: { routes: {} } });
      harness.impersonation.authorize(() => true);
      await makeUser("bob", true);
      await makeUser("alice");

      const client = new Client(harness);
      await client.json("/login", { method: "POST", body: JSON.stringify({ id: "bob" }) });

      expect((await client.send("/impersonate/alice", { method: "POST" })).status).toBe(200);
    });

    it("honours a custom prefix", async () => {
      const harness = await createHarness({
        impersonation: { routes: { prefix: "/admin/act-as" } },
      });
      harness.impersonation.authorize(() => true);
      await makeUser("bob", true);
      await makeUser("alice");

      const client = new Client(harness);
      await client.json("/login", { method: "POST", body: JSON.stringify({ id: "bob" }) });

      expect((await client.send("/admin/act-as/alice", { method: "POST" })).status).toBe(200);
      expect((await client.send("/impersonate/alice", { method: "POST" })).status).toBe(404);
    });

    it("honours a custom route parameter name", async () => {
      const harness = await createHarness({
        impersonation: { routes: { parameter: "target" } },
      });
      harness.impersonation.authorize(() => true);
      await makeUser("bob", true);
      await makeUser("alice");

      const client = new Client(harness);
      await client.json("/login", { method: "POST", body: JSON.stringify({ id: "bob" }) });

      expect((await client.send("/impersonate/alice", { method: "POST" })).status).toBe(200);
    });

    it("guards the routes with authenticate(), so a guest gets 401 not 403", async () => {
      // A 403 would mean "we know who you are and you may not"; a guest
      // is a 401. Also proves the middleware is actually mounted: if
      // `group.middleware()` ran after the routes it would guard nothing,
      // and this would be a 500 from `Auth.user()` instead.
      const harness = await createHarness({ impersonation: { routes: {} } });
      harness.impersonation.authorize(() => true);
      await makeUser("alice");

      const response = await harness.request("/impersonate/alice", { method: "POST" });

      expect(response.status).toBe(401);
    });
  });

  it("contributes the impersonations migration through migrationSources()", async () => {
    const harness = await createHarness();
    const provider = harness.app
      .getProviders()
      .find((candidate) => candidate instanceof ImpersonationServiceProvider);

    // Static, statically-imported sources rather than a directory path,
    // which is the bundle-safe form.
    expect(provider?.migrationSources?.()).toMatchObject([
      { name: "0001_create_impersonations_table" },
    ]);
  });

  it("contributes the gc command", async () => {
    const harness = await createHarness();
    const provider = harness.app
      .getProviders()
      .find((candidate) => candidate instanceof ImpersonationServiceProvider);

    expect(provider?.commands?.()).toEqual([ImpersonationGcCommand]);
  });
});
