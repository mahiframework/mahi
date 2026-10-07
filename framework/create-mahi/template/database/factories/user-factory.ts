import { randomUUID } from "node:crypto";
import { Factory } from "@mahiframework/database";
import { User } from "../../src/models/user.model.js";

/**
 * The `password` default is a PRE-COMPUTED argon2 hash of "password", not
 * a call to `Hash.make()`. `definition()` is synchronous, and hashing
 * per generated row would make every test that creates a user pay ~100ms
 * of deliberate argon2 slowness. Pass an override when a test needs a
 * specific password to log in with.
 */
export const TEST_PASSWORD = "password";
export const TEST_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$pZO4pLrdNfk2w2KmDzQeSw$EHiOq+hyokw8u+vyKYGeCjxNq2GXIsdKdm7bS9PpRzM";

export class UserFactory extends Factory<typeof User> {
  protected model = User;

  protected definition() {
    // A random token only for a locally-unique email default, the real
    // primary key `id` is assigned by the database on insert, and
    // `created_at`/`updated_at` are auto-stamped.
    const token = randomUUID();

    return {
      name: `User ${token.slice(0, 8)}`,
      email: `user-${token}@example.com`,
      password: TEST_PASSWORD_HASH,
      deleted_at: null,
    };
  }
}
