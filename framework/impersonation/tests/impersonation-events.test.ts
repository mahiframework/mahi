import { afterEach, describe, expect, it } from "vitest";
import { clearCurrentApp, EVENTS_TOKEN } from "@mahiframework/core";
import { EventDispatcher } from "@mahiframework/events";
import { ImpersonationFinished, ImpersonationStarted } from "../src/impersonation-events.js";
import { Client, createHarness, makeUser, type UserAttributes } from "./__fixtures__/test-app.js";

describe("impersonation events", () => {
  afterEach(() => clearCurrentApp());

  it("dispatches Started and Finished with the record and both users", async () => {
    const harness = await createHarness({ impersonation: { routes: {} } });
    harness.impersonation.authorize(() => true);
    await makeUser("bob", true);
    await makeUser("alice");

    const dispatcher = new EventDispatcher(harness.app);
    harness.app.instance(EVENTS_TOKEN, dispatcher);

    const started: ImpersonationStarted[] = [];
    const finished: ImpersonationFinished[] = [];
    dispatcher.listen(ImpersonationStarted, (event) => void started.push(event));
    dispatcher.listen(ImpersonationFinished, (event) => void finished.push(event));

    const client = new Client(harness);
    await client.json("/login", { method: "POST", body: JSON.stringify({ id: "bob" }) });
    await client.send("/impersonate/alice", { method: "POST" });

    expect(started).toHaveLength(1);
    expect(started[0]!.record).toMatchObject({
      impersonator_id: "bob",
      impersonated_id: "alice",
      depth: 1,
    });
    // The users are resolved and attached, so a listener need not
    // re-fetch what every listener wants.
    expect((started[0]!.impersonator as UserAttributes).id).toBe("bob");
    expect((started[0]!.impersonated as UserAttributes).id).toBe("alice");

    await client.send("/impersonate", { method: "DELETE" });

    expect(finished).toHaveLength(1);
    expect(finished[0]!.record).toMatchObject({
      impersonator_id: "bob",
      impersonated_id: "alice",
    });
    expect((finished[0]!.impersonator as UserAttributes).id).toBe("bob");
    expect((finished[0]!.impersonated as UserAttributes).id).toBe("alice");
  });

  it("works with no events package bound at all", async () => {
    // The soft-dependency half: an app without an EventsServiceProvider
    // gets working impersonation and no events, rather than a
    // BindingNotFoundError at the worst possible moment.
    const harness = await createHarness({ impersonation: { routes: {} } });
    harness.impersonation.authorize(() => true);
    await makeUser("bob", true);
    await makeUser("alice");

    expect(harness.app.has(EVENTS_TOKEN)).toBe(false);

    const client = new Client(harness);
    await client.json("/login", { method: "POST", body: JSON.stringify({ id: "bob" }) });

    expect((await client.send("/impersonate/alice", { method: "POST" })).status).toBe(200);
    expect((await client.send("/impersonate", { method: "DELETE" })).status).toBe(200);
  });

  it("does not dispatch Finished when an impersonation merely lapses", async () => {
    // gc() is a cleanup job. Firing a "finished" event from a cron hours
    // later would misreport when it happened and hand listeners a
    // request-less context they cannot act in.
    const harness = await createHarness({ impersonation: { routes: {} } });
    harness.impersonation.authorize(() => true);
    await makeUser("bob", true);
    await makeUser("alice");

    const dispatcher = new EventDispatcher(harness.app);
    harness.app.instance(EVENTS_TOKEN, dispatcher);

    const finished: ImpersonationFinished[] = [];
    dispatcher.listen(ImpersonationFinished, (event) => void finished.push(event));

    const client = new Client(harness);
    await client.json("/login", { method: "POST", body: JSON.stringify({ id: "bob" }) });
    await client.send("/impersonate/alice", { method: "POST" });

    await harness.impersonation.gc();

    expect(finished).toEqual([]);
  });
});
