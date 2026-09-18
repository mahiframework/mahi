import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApplication, type TestApplication } from "@mahiframework/testing";
import { bootstrap } from "../bin/bootstrap.js";
import { User } from "../src/models/user.model.js";
import { VerifyEmailMail } from "../src/mail/verify-email.mail.js";
import { registerUser, resetRateLimits } from "./helpers/auth.js";

/**
 * Email verification, end to end.
 *
 * The verification link is a signed URL carrying `id` and `hash`, so these
 * tests read it out of the recorded mailable and GET it, exercising
 * `validateSignature()` middleware and the broker's own hash check
 * together, which is the only way to prove the two compose correctly.
 */
describe("Email verification API", () => {
  let testApp: TestApplication;

  beforeAll(async () => {
    testApp = await createTestApplication(bootstrap, { fakeMail: true });
  });

  beforeEach(async () => {
    await resetRateLimits(testApp);
    testApp.mail?.reset();
  });

  afterAll(async () => {
    await testApp.cleanup();
  });

  /** The verification URL from the most recently recorded mail. */
  function sentVerificationUrl(): string {
    const sent = testApp.mail!.sent(VerifyEmailMail);
    expect(sent.length).toBeGreaterThan(0);

    const button = sent[sent.length - 1]!.data().blocks.find((block) => block.type === "button");
    expect(button).toBeDefined();

    return (button as { url: string }).url;
  }

  describe("on registration", () => {
    it("sends a verification email", async () => {
      await registerUser(testApp);

      testApp.mail!.assertSent(VerifyEmailMail);
    });

    it("leaves the new user unverified", async () => {
      const user = await registerUser(testApp);

      expect((await User.find(BigInt(user.id)))?.email_verified_at).toBeNull();
    });

    it("still returns 201 and a usable token", async () => {
      // Mail is best-effort on this path: a dead SMTP server must not turn a
      // successful registration into a 500, because the retry would fail
      // unique(email) and strand the user with an account they can't reach.
      const user = await registerUser(testApp);

      expect((await user.request("/auth/me")).status).toBe(200);
    });
  });

  describe("GET /auth/verify-email", () => {
    it("verifies the address when the link is valid", async () => {
      const user = await registerUser(testApp);
      const url = sentVerificationUrl();

      const response = await testApp.request(url);

      expect(response.status).toBe(200);
      expect((await User.find(BigInt(user.id)))?.email_verified_at).not.toBeNull();
    });

    it("needs no authentication. The signature is the credential", async () => {
      // Clicking from a mail client that isn't logged in must work.
      await registerUser(testApp);
      const url = sentVerificationUrl();

      const response = await testApp.request(url);

      expect(response.status).toBe(200);
    });

    it("is idempotent, and preserves the first verification timestamp", async () => {
      const user = await registerUser(testApp);
      const url = sentVerificationUrl();

      await testApp.request(url);
      const first = (await User.find(BigInt(user.id)))?.email_verified_at;

      const second = await testApp.request(url);

      expect(second.status).toBe(200);
      expect((await User.find(BigInt(user.id)))?.email_verified_at?.toISOString()).toBe(
        first?.toISOString(),
      );
    });

    it("rejects a tampered id with 403", async () => {
      const victim = await registerUser(testApp);
      testApp.mail!.reset();
      const attacker = await registerUser(testApp);

      // Swap the id in the attacker's own signed link for the victim's.
      const url = sentVerificationUrl().replace(`id=${attacker.id}`, `id=${victim.id}`);

      const response = await testApp.request(url);

      // validateSignature() rejects before the handler ever runs.
      expect(response.status).toBe(403);
      expect((await User.find(BigInt(victim.id)))?.email_verified_at).toBeNull();
    });

    it("rejects a missing signature with 403", async () => {
      const user = await registerUser(testApp);
      const url = new URL(sentVerificationUrl(), "https://app.test");
      url.searchParams.delete("signature");

      const response = await testApp.request(`${url.pathname}${url.search}`);

      expect(response.status).toBe(403);
      expect((await User.find(BigInt(user.id)))?.email_verified_at).toBeNull();
    });

    it("rejects a link whose address changed after it was issued", async () => {
      // The hole the email hash closes. The signature is still valid, the
      // URL was legitimately signed, so only the hash catches this.
      const user = await registerUser(testApp);
      const url = sentVerificationUrl();

      await User.update(BigInt(user.id), { email: `changed-${user.id}@example.com` });

      const response = await testApp.request(url);

      expect(response.status).toBe(422);
      expect((await User.find(BigInt(user.id)))?.email_verified_at).toBeNull();
    });
  });

  describe("POST /auth/verify-email/resend", () => {
    it("requires authentication", async () => {
      const response = await testApp.request("/auth/verify-email/resend", { method: "POST" });

      expect(response.status).toBe(401);
    });

    it("sends another link to the caller's own address", async () => {
      const user = await registerUser(testApp);
      testApp.mail!.reset();

      const response = await user.request("/auth/verify-email/resend", { method: "POST" });

      expect(response.status).toBe(200);
      testApp.mail!.assertSentTimes(VerifyEmailMail, 1);
    });

    it("issues a link that actually verifies", async () => {
      const user = await registerUser(testApp);
      testApp.mail!.reset();

      await user.request("/auth/verify-email/resend", { method: "POST" });
      const response = await testApp.request(sentVerificationUrl());

      expect(response.status).toBe(200);
      expect((await User.find(BigInt(user.id)))?.email_verified_at).not.toBeNull();
    });

    it("sends nothing once the address is verified", async () => {
      const user = await registerUser(testApp);
      await testApp.request(sentVerificationUrl());
      testApp.mail!.reset();

      const response = await user.request("/auth/verify-email/resend", { method: "POST" });

      expect(response.status).toBe(200);
      testApp.mail!.assertNotSent(VerifyEmailMail);
    });

    it("keeps earlier links working. Resending does not invalidate them", async () => {
      // Documented consequence of storing no token: verification links
      // cannot be revoked before they expire.
      const user = await registerUser(testApp);
      const firstUrl = sentVerificationUrl();
      testApp.mail!.reset();

      await user.request("/auth/verify-email/resend", { method: "POST" });

      expect((await testApp.request(firstUrl)).status).toBe(200);
    });
  });
});
