import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Attempted,
  Authenticated,
  CsrfTokenMismatch,
  CurrentDeviceLogout,
  EmailVerificationSent,
  EmailVerified,
  Failed,
  Login,
  Logout,
  OtherDeviceLogout,
  PasswordReset,
  PasswordResetLinkSent,
  TokenCreated,
  TokenRevoked,
  runWithAuth,
} from "@mahiframework/auth";
import { createHarness, User, type Harness } from "./__fixtures__/test-app.js";

describe("security listener", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(() => harness.cleanup());

  it("records a login", async () => {
    await harness.events.dispatch(new Login("u-1", { id: "u-1" }, "sess-1", false, "web"));

    const rows = await harness.rows();
    expect(rows[0]).toMatchObject({
      type: "security",
      action: "login",
      model_type: "User",
      model_id: "u-1",
    });
    expect(rows[0]!.data).toMatchObject({ guard: "web", remember: false });
  });

  it("records a logout when a user is known", async () => {
    await harness.events.dispatch(new Logout("u-1", { id: "u-1" }, "sess-1", "web"));

    expect((await harness.rows())[0]).toMatchObject({ action: "logout", model_id: "u-1" });
  });

  it("writes nothing for a logout with no user", async () => {
    // `logout()` destroys a session without loading a user, so a route
    // that never ran `authenticate()` has nobody to attribute it to.
    await harness.events.dispatch(new Logout(null, null, null, "web"));

    expect(await harness.rows()).toEqual([]);
  });

  it("records a failed login against the submitted address", async () => {
    await harness.events.dispatch(new Failed({ email: "nobody@example.com" }, "web"));

    const rows = await harness.rows();
    // No user id exists and cannot: `attempt()` returns null for both
    // "no such account" and "wrong password", deliberately. The address
    // goes in `model_id` to keep the index usable and in `data` because a
    // key column holding an email is a lie about the column's meaning.
    expect(rows[0]).toMatchObject({
      action: "password_incorrect",
      model_id: "nobody@example.com",
    });
    expect(rows[0]!.data).toMatchObject({ email: "nobody@example.com" });
  });

  it("falls back to a username when that is the identifying column", async () => {
    await harness.events.dispatch(new Failed({ username: "alice" }, "web"));

    expect((await harness.rows())[0]).toMatchObject({ model_id: "alice" });
  });

  it("never records a password, because auth strips it before dispatch", async () => {
    await harness.events.dispatch(new Failed({ email: "a@b.test" }, "web"));

    expect(JSON.stringify(await harness.rows())).not.toContain("hunter2");
  });

  it("records a password change and a reset request", async () => {
    await harness.events.dispatch(new PasswordReset("a@b.test", { id: "u-1" }));
    await harness.events.dispatch(new PasswordResetLinkSent("a@b.test", { id: "u-1" }));

    const rows = await harness.rows();
    expect(rows.map((row) => row.action)).toEqual([
      "password_changed",
      "password_change_requested",
    ]);
    expect(rows[0]!.model_id).toBe("u-1");
  });

  it("records email verification, sent and completed", async () => {
    await harness.events.dispatch(new EmailVerificationSent("u-1", "a@b.test", {}));
    await harness.events.dispatch(new EmailVerified("u-1", "a@b.test", {}));

    expect((await harness.rows()).map((row) => row.action)).toEqual([
      "email_verification_sent",
      "email_verified",
    ]);
  });

  it("records token creation without the plaintext", async () => {
    await harness.events.dispatch(new TokenCreated("u-1", "tok-1", "login", "api"));

    const rows = await harness.rows();
    expect(rows[0]).toMatchObject({ action: "token_created", model_id: "u-1" });
    expect(rows[0]!.data).toMatchObject({ token_id: "tok-1", name: "login" });
  });

  it("records a bulk token revocation but not a single one", async () => {
    // A single revocation carries no user: `revokeToken(id)` does not read
    // the row it deletes, so there is nothing to attribute. A row whose
    // subject was a token id masquerading as a user key would be worse.
    await harness.events.dispatch(new TokenRevoked("tok-1", null, false));
    await harness.events.dispatch(new TokenRevoked(null, "u-1", true, "password_reset"));

    const rows = await harness.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "token_revoked", model_id: "u-1" });
    expect(rows[0]!.data).toMatchObject({ all: true, reason: "password_reset" });
  });

  it("distinguishes the two session-revocation scopes", async () => {
    await harness.events.dispatch(new CurrentDeviceLogout("u-1", "password_reset", "web"));
    await harness.events.dispatch(new OtherDeviceLogout("u-1", "sess-1", "web"));

    const rows = await harness.rows();
    expect(rows.map((row) => row.action)).toEqual(["sessions_revoked", "sessions_revoked"]);
    expect(rows[0]!.data).toMatchObject({ scope: "all", reason: "password_reset" });
    expect(rows[1]!.data).toMatchObject({ scope: "others" });
  });

  it("records a CSRF rejection only when someone is authenticated", async () => {
    // An anonymous rejection has no subject at all, and inventing one
    // would be worse than leaving it to the access log.
    await harness.events.dispatch(new CsrfTokenMismatch("POST", "/pay"));
    expect(await harness.rows()).toEqual([]);

    await runWithAuth({ user: { id: "u-9" }, guard: "web" }, async () => {
      await harness.events.dispatch(new CsrfTokenMismatch("POST", "/pay"));
    });

    const rows = await harness.rows();
    expect(rows[0]).toMatchObject({ action: "csrf_rejected", model_id: "u-9" });
  });

  it("ignores Authenticated, which fires on every request", async () => {
    // Recording it would write a row per API call and drown the table.
    // `Login` is the event that means "signed in".
    await harness.events.dispatch(new Authenticated("u-1", { id: "u-1" }, "web"));

    expect(await harness.rows()).toEqual([]);
  });

  it("ignores Attempted, because Failed already covers the half worth recording", async () => {
    await harness.events.dispatch(new Attempted({ email: "a@b.test" }, true, { id: "u-1" }, "web"));

    expect(await harness.rows()).toEqual([]);
  });

  it("attributes to the ambient actor when there is one", async () => {
    // An admin revoking someone else's tokens is recorded as the admin,
    // with the victim as the subject.
    await runWithAuth({ user: { id: "admin-1" }, guard: "web" }, async () => {
      await harness.events.dispatch(new TokenRevoked(null, "u-1", true));
    });

    const rows = await harness.rows();
    expect(rows[0]).toMatchObject({ model_id: "u-1", user_id: "admin-1" });
  });

  it("does not throw outside a request scope, where there is no auth context", async () => {
    // `currentAuthState()` returns undefined rather than throwing, which
    // is why the actor lookup cannot use `Auth.userOrNull()`.
    await expect(
      harness.events.dispatch(new Login("u-1", { id: "u-1" }, "s", false, "web")),
    ).resolves.toBeUndefined();

    expect((await harness.rows())[0]!.user_id).toBe("u-1");
  });

  it("honours a security actions allowlist", async () => {
    harness.cleanup();
    harness = await createHarness({ security: { actions: ["login"] } });

    await harness.events.dispatch(new Login("u-1", { id: "u-1" }, "s", false, "web"));
    await harness.events.dispatch(new Logout("u-1", { id: "u-1" }, "s", "web"));

    expect((await harness.rows()).map((row) => row.action)).toEqual(["login"]);
  });

  it("writes nothing when security logging is off", async () => {
    harness.cleanup();
    harness = await createHarness({ security: { enabled: false } });

    await harness.events.dispatch(new Login("u-1", { id: "u-1" }, "s", false, "web"));

    expect(await harness.rows()).toEqual([]);
  });

  it("writes nothing when the package is disabled", async () => {
    harness.cleanup();
    harness = await createHarness({ enabled: false });

    await harness.events.dispatch(new Login("u-1", { id: "u-1" }, "s", false, "web"));

    expect(await harness.rows()).toEqual([]);
  });

  describe("email changes", () => {
    it("writes a second security row alongside the resource row", async () => {
      harness.cleanup();
      harness = await createHarness({ resources: { User: "columns" } });

      const user = await User.create({ id: "u-1", email: "old@b.test", password: "x" });
      user.email = "new@b.test";
      await user.save();

      const rows = await harness.rows();
      // Two rows for one act, deliberately: a security query filtered to
      // `type = "security"` must not have to scan resource rows looking
      // for a column name.
      expect(rows.map((row) => `${row.type}/${row.action}`)).toEqual([
        "resource/created",
        "resource/updated",
        "security/email_changed",
      ]);
      expect(rows[2]!.data).toMatchObject({ from: "old@b.test", to: "new@b.test" });
    });

    it("does not fire for a non-email change", async () => {
      harness.cleanup();
      harness = await createHarness({ resources: { User: "columns" } });

      const user = await User.create({ id: "u-1", email: "a@b.test", password: "x" });
      user.password = "y";
      await user.save();

      const rows = await harness.rows();
      expect(rows.map((row) => row.type)).toEqual(["resource", "resource"]);
    });
  });
});
