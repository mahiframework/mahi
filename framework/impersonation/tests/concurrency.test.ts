import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearCurrentApp } from "@mahiframework/core";
import { Client, createHarness, makeUser, type Harness } from "./__fixtures__/test-app.js";

/**
 * Impersonation must not leak between concurrent requests.
 *
 * This is the test that stops the package being "simplified" into a
 * security bug. `@mahiframework/auth` already ships `setActingAs()`, whose
 * docblock literally mentions impersonation, and reaching for it here
 * would look like a shortcut and work perfectly in a single-threaded test.
 * It is PROCESS-GLOBAL: one `Application` serves every concurrent request,
 * so setting it would authenticate every other in-flight request as the
 * impersonated user. That function is for tests.
 *
 * Modelled on `framework/auth/tests/auth-context.test.ts`'s
 * "does not leak between concurrent scopes".
 */
describe("concurrent impersonations", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({ impersonation: { routes: {} } });
    harness.impersonation.authorize(() => true);

    await makeUser("admin-one", true);
    await makeUser("admin-two", true);
    await makeUser("alice");
    await makeUser("jane");
  });

  afterEach(() => clearCurrentApp());

  it("keeps two admins impersonating different users separate", async () => {
    const one = new Client(harness);
    const two = new Client(harness);

    await one.json("/login", { method: "POST", body: JSON.stringify({ id: "admin-one" }) });
    await two.json("/login", { method: "POST", body: JSON.stringify({ id: "admin-two" }) });

    await Promise.all([
      one.send("/impersonate/alice", { method: "POST" }),
      two.send("/impersonate/jane", { method: "POST" }),
    ]);

    const [first, second] = await Promise.all([whoami(one), whoami(two)]);

    expect(first).toMatchObject({ user: { id: "alice" }, impersonator: "admin-one" });
    expect(second).toMatchObject({ user: { id: "jane" }, impersonator: "admin-two" });
  });

  it("does not leak an impersonation into an unrelated request", async () => {
    // The failure mode a process-global override would produce: a third
    // party, who never impersonated anyone, seeing the impersonated
    // identity.
    const admin = new Client(harness);
    const bystander = new Client(harness);

    await admin.json("/login", { method: "POST", body: JSON.stringify({ id: "admin-one" }) });
    await bystander.json("/login", { method: "POST", body: JSON.stringify({ id: "admin-two" }) });

    await admin.send("/impersonate/alice", { method: "POST" });

    await expect(whoami(bystander)).resolves.toMatchObject({
      user: { id: "admin-two" },
      impersonating: false,
      impersonator: null,
    });
  });

  it("survives interleaved requests with real await points between them", async () => {
    const one = new Client(harness);
    const two = new Client(harness);

    await one.json("/login", { method: "POST", body: JSON.stringify({ id: "admin-one" }) });
    await two.json("/login", { method: "POST", body: JSON.stringify({ id: "admin-two" }) });

    await one.send("/impersonate/alice", { method: "POST" });
    await two.send("/impersonate/jane", { method: "POST" });

    // Interleave several rounds, so a leak has every opportunity to show
    // up after a yield rather than only on the first read.
    const seen: string[] = [];

    for (let round = 0; round < 3; round++) {
      const [first, second] = await Promise.all([
        whoami(one) as Promise<{ user: { id: string } }>,
        whoami(two) as Promise<{ user: { id: string } }>,
      ]);

      seen.push(first.user.id, second.user.id);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    expect(seen).toEqual(["alice", "jane", "alice", "jane", "alice", "jane"]);
  });

  it("stops one admin's impersonation without affecting the other's", async () => {
    const one = new Client(harness);
    const two = new Client(harness);

    await one.json("/login", { method: "POST", body: JSON.stringify({ id: "admin-one" }) });
    await two.json("/login", { method: "POST", body: JSON.stringify({ id: "admin-two" }) });
    await one.send("/impersonate/alice", { method: "POST" });
    await two.send("/impersonate/jane", { method: "POST" });

    await one.send("/impersonate", { method: "DELETE" });

    await expect(whoami(one)).resolves.toMatchObject({
      user: { id: "admin-one" },
      impersonating: false,
    });
    await expect(whoami(two)).resolves.toMatchObject({
      user: { id: "jane" },
      impersonating: true,
    });
  });

  async function whoami(client: Client): Promise<unknown> {
    return (await client.send("/me")).json();
  }
});
