import { afterEach, describe, expect, it } from "vitest";
import { clearCurrentApp, EVENTS_TOKEN } from "@mahiframework/core";
import { EventDispatcher } from "@mahiframework/events";
import { Login } from "@mahiframework/auth";
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

  it("fires an auth Login on both start and stop, because both establish a session", async () => {
    // Impersonating is not a special kind of authentication: `start()` and
    // `stop()` both go through `Auth.login()`, which destroys the old
    // session and writes a new one. So each dispatches `auth.Login`, and
    // that is accurate rather than a leak.
    //
    // It is pinned here because the consequence is easy to get wrong
    // downstream: an audit log listening on `Login` alone records an
    // impersonation as an ordinary sign-in, twice, and attributes the
    // second one to the admin as though they had re-authenticated. A
    // listener that cares must pair this with the impersonation events, or
    // check `rootImpersonator()`.
    const harness = await createHarness({ impersonation: { routes: {} } });
    harness.impersonation.authorize(() => true);
    await makeUser("bob", true);
    await makeUser("alice");

    const dispatcher = new EventDispatcher(harness.app);
    harness.app.instance(EVENTS_TOKEN, dispatcher);

    const logins: Login[] = [];
    const started: ImpersonationStarted[] = [];
    const finished: ImpersonationFinished[] = [];
    dispatcher.listen(Login, (event) => void logins.push(event));
    dispatcher.listen(ImpersonationStarted, (event) => void started.push(event));
    dispatcher.listen(ImpersonationFinished, (event) => void finished.push(event));

    const client = new Client(harness);
    await client.json("/login", { method: "POST", body: JSON.stringify({ id: "bob" }) });
    await client.send("/impersonate/alice", { method: "POST" });
    await client.send("/impersonate", { method: "DELETE" });

    // Three, not two: the harness's own `/login` route is the first, then
    // one per impersonation boundary.
    expect(logins.map((event) => event.userId)).toEqual(["bob", "alice", "bob"]);

    // Each carries a real, distinct session id, which is what proves these
    // are genuine logins and not an artefact.
    expect(new Set(logins.map((event) => event.sessionId)).size).toBe(3);
    expect(logins.every((event) => event.guard === "session")).toBe(true);

    // The pairing a listener needs to tell the three apart. Both
    // impersonation events fire, so `Login` is never the only signal.
    expect(started).toHaveLength(1);
    expect(finished).toHaveLength(1);
  });

  it("does not report an impersonation login as remembered", async () => {
    // `start()` passes no `remember`, and `stop()` passes back whatever
    // the admin's original session was. Asserting both documents the
    // asymmetry: it is not that impersonation ignores remember-me, it is
    // that entering never remembers and leaving restores.
    const harness = await createHarness({ impersonation: { routes: {} } });
    harness.impersonation.authorize(() => true);
    await makeUser("bob", true);
    await makeUser("alice");

    const dispatcher = new EventDispatcher(harness.app);
    harness.app.instance(EVENTS_TOKEN, dispatcher);

    const logins: Login[] = [];
    dispatcher.listen(Login, (event) => void logins.push(event));

    const client = new Client(harness);
    await client.json("/login", {
      method: "POST",
      body: JSON.stringify({ id: "bob", remember: true }),
    });
    await client.send("/impersonate/alice", { method: "POST" });
    await client.send("/impersonate", { method: "DELETE" });

    expect(logins.map((event) => event.remember)).toEqual([true, false, true]);
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
