import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearCurrentApp } from "@mahiframework/core";
import { DateTime } from "@mahiframework/datetime";
import { ImpersonationLink } from "../src/models/impersonation-link.js";
import { ImpersonationGcCommand } from "../src/commands/impersonation-gc.js";
import { Client, createHarness, makeUser, User, type Harness } from "./__fixtures__/test-app.js";

describe("gc", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({ impersonation: { routes: {} } });
    harness.impersonation.authorize(() => true);
    await makeUser("bob", true);
    await makeUser("alice");
  });

  afterEach(() => clearCurrentApp());

  it("leaves a live impersonation alone", async () => {
    const client = new Client(harness);
    await client.json("/login", { method: "POST", body: JSON.stringify({ id: "bob" }) });
    await client.send("/impersonate/alice", { method: "POST" });

    expect(await harness.impersonation.gc()).toBe(0);

    await expect(whoami(client)).resolves.toMatchObject({ impersonating: true });
  });

  it("deletes a lapsed one and reports the count", async () => {
    const client = new Client(harness);
    await client.json("/login", { method: "POST", body: JSON.stringify({ id: "bob" }) });
    const started = await client.send("/impersonate/alice", { method: "POST" });
    expect(started.status).toBe(200);

    const link = (await ImpersonationLink.query().get()).all()[0]!;
    await ImpersonationLink.update(link.id, {
      expires_at: DateTime.now().subMinutes(1),
    });

    expect(await harness.impersonation.gc()).toBe(1);
    expect((await ImpersonationLink.query().get()).all()).toEqual([]);
  });

  it("is driven by the impersonation:gc command", async () => {
    const client = new Client(harness);
    await client.json("/login", { method: "POST", body: JSON.stringify({ id: "bob" }) });
    await client.send("/impersonate/alice", { method: "POST" });

    const link = (await ImpersonationLink.query().get()).all()[0]!;
    await ImpersonationLink.update(link.id, {
      expires_at: DateTime.now().subMinutes(1),
    });

    await new ImpersonationGcCommand(harness.app).handle();

    expect((await ImpersonationLink.query().get()).all()).toEqual([]);
  });

  async function whoami(client: Client): Promise<unknown> {
    return (await client.send("/me")).json();
  }
});

describe("when the impersonator's account is gone", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({ impersonation: { routes: {} } });
    harness.impersonation.authorize(() => true);
    await makeUser("bob", true);
    await makeUser("alice");
  });

  afterEach(() => clearCurrentApp());

  it("logs the session out entirely rather than stranding it as the target", async () => {
    // The alternative is worse than an error: leaving the session logged
    // in as the impersonated user would silently convert a deleted
    // admin's impersonation into a permanent, unaudited login to someone
    // else's account.
    const client = new Client(harness);
    await client.json("/login", { method: "POST", body: JSON.stringify({ id: "bob" }) });
    await client.send("/impersonate/alice", { method: "POST" });

    await User.delete("bob");

    const stopped = await client.send("/impersonate", { method: "DELETE" });

    // 409, not 403: nothing is forbidden, the state is irreconcilable.
    expect(stopped.status).toBe(409);

    // And the session is gone, so the client must re-authenticate rather
    // than continuing as Alice.
    expect((await client.send("/me")).status).toBe(401);
  });
});
