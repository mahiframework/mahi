import { Auth } from "@mahiframework/auth";
import { app } from "@mahiframework/core";
import { Controller, HttpResponse } from "@mahiframework/http";
import { Mail } from "@mahiframework/mail";
import type { User } from "../../models/user.model.js";
import { VerifyEmailMail } from "../../mail/verify-email.mail.js";

/**
 * POST /auth/verify-email/resend
 *
 * Authenticated, and only ever mails the caller's own address. Which is
 * why there's no per-mailbox throttle like the forgot-password endpoint
 * has. A stranger cannot point this at someone else's inbox, so the
 * ordinary `throttle()` middleware on the route is the right control.
 *
 * Verification links are signed URLs with no stored state, so re-sending
 * simply mints another one; the previous link keeps working until it
 * expires. If you need re-sending to invalidate earlier links, you want a
 * token table and should model it on the password-reset flow.
 */
export class ResendVerificationController extends Controller {
  async handle() {
    const user = Auth.user<User>();

    const result = await Auth.verificationBroker().sendVerificationLink(String(user.id));

    if (result.status === "already-verified") {
      return HttpResponse.json({ message: "Your email address is already verified." });
    }

    if (result.status === "sent" && this.shouldSendEmail()) {
      const expiresInMinutes = app().config.get<number>("auth.verification.expiresInMinutes", 60);
      await Mail.send(new VerifyEmailMail(user.email, result.url, expiresInMinutes));
    }

    return HttpResponse.json({ message: "A verification link has been sent to your email." });
  }

  /** `AUTH_SEND_VERIFY_EMAIL=false` hands delivery back to the app. */
  private shouldSendEmail(): boolean {
    return app().config.get<boolean>("auth.notifications.verifyEmail", true);
  }
}
