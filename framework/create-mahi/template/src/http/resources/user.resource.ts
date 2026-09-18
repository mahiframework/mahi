import { Resource } from "@mahiframework/http";
import type { User } from "../../models/user.model.js";

export interface UserJson {
  /** A string, not a number: a 64-bit id loses precision as JSON. */
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

/**
 * The primary, explicit shaper of the user wire format. It simply never
 * reads `password`, so the hash can't reach a response through here.
 *
 * Defense-in-depth: `User` also declares `hidden: ["password"]`,
 * so even a stray `HttpResponse.json(user)` won't leak the hash. This
 * resource is still the canonical way to render a user (camelCase keys,
 * computed fields). `hidden` is the safety net, not a replacement.
 */
export class UserResource extends Resource<User, UserJson> {
  toJson(): UserJson {
    return {
      id: String(this.model.id),
      name: this.model.name,
      email: this.model.email,
      // `created_at` is a `DateTime` here, not a string: the model casts
      // it (timestamps are auto-cast when `timestamps` is on), and
      // `this.model` is the instance, so the read goes through the cast.
      createdAt: this.model.created_at.toISOString(),
    };
  }
}
