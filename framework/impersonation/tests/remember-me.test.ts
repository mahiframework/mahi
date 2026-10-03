import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearCurrentApp } from "@mahiframework/core";
import { ImpersonationLink } from "../src/models/impersonation-link.js";
import {
  Client,
  createHarness,
  makeUser,
  maxAgeFrom,
  type Harness,
} from "./__fixtures__/test-app.js";

const LIFETIME = 120;
const REMEMBER = 400 * 24 * 60;

/**
 * Remember-me surviving an impersonation round trip.
 *
 * `SessionGuard.login()` destroys the session it replaces, which is its
 * session-fixation defence, so an admin on a long-lived session would
 * naively come back from an impersonation on a short one. It does not have
 * to: this framework deliberately rejected Laravel's recaller cookie, so
 * remember-me is nothing but "use `rememberMinutes` instead of
 * `lifetimeMinutes`". One boolean, recoverable, and inferable from the
 * replaced session's expiry.
 */
describe("remember-me across an impersonation", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({
      impersonation: { routes: {}, maxDepth: 2 },
      lifetimeMinutes: LIFETIME,
      rememberMinutes: REMEMBER,
    });
    harness.impersonation.authorize(() => true);

    await makeUser("bob", true);
    await makeUser("alice");
    await makeUser("jane");
  });

  afterEach(() => clearCurrentApp());

  it("restores a remembered session on stop()", async () => {
    const client = new Client(harness);

    const login = await client.json("/login", {
      method: "POST",
      body: JSON.stringify({ id: "bob", remember: true }),
    });
    expect(maxAgeFrom(login)).toBe(REMEMBER * 60);

    // The impersonation session itself is ordinary: nobody wants to be
    // left impersonating someone for 400 days.
    const started = await client.send("/impersonate/alice", { method: "POST" });
    expect(maxAgeFrom(started)).toBe(LIFETIME * 60);

    const stopped = await client.send("/impersonate", { method: "DELETE" });

    // The assertion that matters. Bob is back on a long-lived session.
    expect(maxAgeFrom(stopped)).toBe(REMEMBER * 60);
  });

  it("does NOT upgrade an ordinary session to a remembered one", async () => {
    // The inverse error is just as bad: silently extending a short
    // session to 400 days because someone impersonated from it.
    const client = new Client(harness);

    const login = await client.json("/login", {
      method: "POST",
      body: JSON.stringify({ id: "bob" }),
    });
    expect(maxAgeFrom(login)).toBe(LIFETIME * 60);

    await client.send("/impersonate/alice", { method: "POST" });
    const stopped = await client.send("/impersonate", { method: "DELETE" });

    expect(maxAgeFrom(stopped)).toBe(LIFETIME * 60);
  });

  it("records the inference on the row, per link", async () => {
    const client = new Client(harness);
    await client.json("/login", {
      method: "POST",
      body: JSON.stringify({ id: "bob", remember: true }),
    });

    await client.send("/impersonate/alice", { method: "POST" });
    await client.send("/impersonate/jane", { method: "POST" });

    // Each row records the remembered-ness of the session IT replaced.
    // The outer link replaced Bob's remembered session; the inner one
    // replaced an impersonation session, which never is.
    const links = await ImpersonationLink.query().orderBy("depth").get();

    // `remembered` reads back as a real boolean, not sqlite's 0/1, which
    // is `Cast.boolean()` doing its job.
    expect(links.all().map((link) => [link.depth, link.remembered])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it("unwinds a nested chain all the way back to the remembered session", async () => {
    const client = new Client(harness);
    await client.json("/login", {
      method: "POST",
      body: JSON.stringify({ id: "bob", remember: true }),
    });

    await client.send("/impersonate/alice", { method: "POST" });
    await client.send("/impersonate/jane", { method: "POST" });

    // Unwinding to Alice gives an ordinary session...
    const toAlice = await client.send("/impersonate", { method: "DELETE" });
    expect(maxAgeFrom(toAlice)).toBe(LIFETIME * 60);

    // ...and unwinding again gets Bob his long session back.
    const toBob = await client.send("/impersonate", { method: "DELETE" });
    expect(maxAgeFrom(toBob)).toBe(REMEMBER * 60);
  });

  it("degrades to 'not remembered' when rememberMinutes <= lifetimeMinutes", async () => {
    // The inference reads the replaced session's expiry against the
    // ordinary lifetime. Configure the two to be equal and the kinds are
    // genuinely indistinguishable, which costs nothing because they are
    // also genuinely equivalent.
    const h = await createHarness({
      impersonation: { routes: {} },
      lifetimeMinutes: 120,
      rememberMinutes: 120,
    });
    h.impersonation.authorize(() => true);
    await makeUser("bob", true);
    await makeUser("alice");

    const client = new Client(h);
    await client.json("/login", {
      method: "POST",
      body: JSON.stringify({ id: "bob", remember: true }),
    });

    await client.send("/impersonate/alice", { method: "POST" });
    const stopped = await client.send("/impersonate", { method: "DELETE" });

    expect(maxAgeFrom(stopped)).toBe(120 * 60);
  });
});
