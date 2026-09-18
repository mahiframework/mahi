import { Auth, TokenGuard } from "@mahiframework/auth";
import { Hash } from "@mahiframework/encryption";
import { Controller, HttpResponse, HttpError } from "@mahiframework/http";
import { User } from "../../models/user.model.js";
import { UserResource } from "../resources/user.resource.js";
import { LoginRequest } from "../requests/login.request.js";

/** POST /auth/login */
export class LoginController extends Controller<LoginRequest> {
  request = LoginRequest;

  async handle(request: LoginRequest) {
    const body = request.validated();

    const user = await Auth.attempt<User>({ email: body.email, password: body.password });

    if (user === null) {
      // One message for both "no such account" and "wrong password", the
      // pairing to Auth.attempt()'s constant-time behaviour. Distinguishing
      // them here would leak account existence through the response body,
      // undoing the timing work entirely.
      throw HttpError.unauthorized("Invalid credentials.");
    }

    // Transparently upgrade the stored hash if argon2's parameters have
    // moved on since it was written. Only possible right here, since it's
    // the one moment the framework legitimately holds the plaintext.
    if (Hash.needsRehash(user.password)) {
      await User.update(user.id, { password: await Hash.make(body.password) });
    }

    const guard = Auth.guard("token") as TokenGuard<User>;
    const { token } = await guard.createToken(String(user.id), "login");

    return HttpResponse.json({ user: new UserResource(user).toJson(), token });
  }
}
