import { Hash } from "@mahiframework/encryption";
import { Auth, TokenGuard } from "@mahiframework/auth";
import { app } from "@mahiframework/core";
import { Controller, HttpResponse } from "@mahiframework/http";
import { Mail } from "@mahiframework/mail";
import { User } from "../../models/user.model.js";
import { UserResource } from "../resources/user.resource.js";
import { VerifyEmailMail } from "../../mail/verify-email.mail.js";
import { RegisterRequest } from "../requests/register.request.js";

/** POST /auth/register */
export class RegisterController extends Controller<RegisterRequest> {
  request = RegisterRequest;

  async handle(request: RegisterRequest) {
    const payload = request.validated();

    // `create()` hands back a hydrated `User` instance, not a plain row,
    // so `user.id` below and `new UserResource(user)` both get the real
    // model, casts and methods included.
    const user = await User.create({
      name: payload.name,
      email: payload.email,
      password: await Hash.make(payload.password),
      email_verified_at: null,
    });

    await this.sendVerificationEmail(user);

    const guard = Auth.guard("token") as TokenGuard<User>;
    const { token } = await guard.createToken(String(user.id), "registration");

    return HttpResponse.json({ user: new UserResource(user).toJson(), token }, 201);
  }

  /**
   * Mail the verification link, best-effort.
   *
   * Failures are swallowed deliberately: the account IS created by this
   * point, so a dead SMTP server must not turn a successful registration
   * into a 500 that tells the user to try again. The retry would fail
   * `unique(email)` validation and strand them with an account they can't
   * sign into. `/auth/verify-email/resend` is the recovery path.
   *
   * This is the opposite call to the one in `ForgotPasswordController`,
   * which deletes its token and rethrows. The difference is what a retry
   * costs: a reset can be requested again freely, a registration cannot.
   */
  private async sendVerificationEmail(user: User): Promise<void> {
    if (!app().config.get<boolean>("auth.notifications.verifyEmail", true)) {
      return;
    }

    try {
      const result = await Auth.verificationBroker().sendVerificationLink(String(user.id));

      if (result.status === "sent") {
        const expiresInMinutes = app().config.get<number>("auth.verification.expiresInMinutes", 60);
        await Mail.send(new VerifyEmailMail(user.email, result.url, expiresInMinutes));
      }
    } catch (error) {
      app().logger.error("Failed to send verification email", { userId: user.id, error });
    }
  }
}
