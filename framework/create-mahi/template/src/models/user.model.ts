import { Cast, Model } from "@mahiframework/database";
import { snowflake } from "@mahiframework/snowflake";
import type { DateTime } from "@mahiframework/datetime";
import { UserFactory } from "../../database/factories/user-factory.js";
import { UserResource } from "../http/resources/user.resource.js";

/**
 * The app owns this model and its migration, NOT the framework. Every
 * real app wants its own columns here (tenant, avatar, role, ...). The
 * `@mahiframework/auth` package only ships the tables internal to its own guards.
 *
 * The single `UserAttributes` interface is the whole declaration: plain
 * columns are plain types, and the timestamps are `DateTime` (auto-cast
 * because `timestamps`/`softDeletes` are on). Soft-deleted users stop
 * authenticating automatically, `DatabaseUserProvider` looks users up
 * through `Model.query()`, so the soft-delete scope applies with no extra
 * code.
 */
export interface UserAttributes {
  /** A snowflake, hence `bigint`: a 64-bit id does not fit a `number`. */
  id: bigint;
  name: string;
  email: string;
  /** argon2 hash, never the plaintext, and never serialised (see UserResource). */
  password: string;
  /** Null until the address is verified. See `Auth.verificationBroker()`. */
  email_verified_at: DateTime | null;
  created_at: DateTime;
  updated_at: DateTime;
  deleted_at: DateTime | null;
}

export class User extends Model<UserAttributes>()({
  table: "users",
  primaryKey: "id",
  keyType: snowflake(),
  softDeletes: true,
  morphName: "User",
  hidden: ["password"],
  // `created_at`/`updated_at`/`deleted_at` are cast automatically because
  // `timestamps`/`softDeletes` are on; any *other* DateTime column has to
  // say so explicitly, and the model factory enforces that at compile time.
  casts: { email_verified_at: Cast.datetime() },
}) {
  /**
   * Makes `User.factory()` resolve `UserFactory`, so seeders and tests
   * read the Laravel way (`User.factory().times(10).create()`).
   */
  static factory(): UserFactory {
    return new UserFactory();
  }

  /**
   * `User`'s default API resource, makes `user.toJsonResource()` resolve
   * a `UserResource`, so a `User` embedded raw in another resource's
   * output serialises through it automatically. The proxy binds `this`, so
   * the resource's `this.model.*` reads resolve cast columns directly.
   */
  override toJsonResource(): UserResource {
    return new UserResource(this);
  }
}
