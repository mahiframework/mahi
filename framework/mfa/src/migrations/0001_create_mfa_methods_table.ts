import { Schema, type Migration, type Blueprint } from "@mahiframework/database";

/**
 * `mfa_methods`, what a user has enrolled.
 *
 * `secret` holds AES-GCM ciphertext (via `Crypt`), never plaintext and
 * never a hash. Unlike a password or a reset token, TOTP verification
 * has to recover the secret to recompute the expected code, so hashing
 * is not available; encryption with the secret's owner bound in as AAD
 * is the next best thing, and means a leaked dump is useless without
 * `APP_KEY`.
 *
 * `confirmed_at` is null until the user has proved one code generated
 * from the secret. An unconfirmed row is invisible to every "is this
 * user enrolled?" query, which is what stops a mistyped or stale
 * enrollment from locking its owner out of an account it appears to
 * protect.
 *
 * `last_used_timestep` is the TOTP replay floor. A code stays valid for
 * its whole period, so without recording the step that was consumed the
 * same code verifies repeatedly, and at the default window that is up to
 * 90 seconds of a reusable "second factor".
 *
 * `user_id` is text, not `bigInteger`, and carries no foreign key: the
 * users table is app-owned, the framework cannot assume its name, and
 * the key type is the app's choice (a `uuid` key must not be rejected
 * outright by the column type). Same rationale as the `sessions` and
 * `personal_access_tokens` tables.
 */
const migration: Migration = {
  async up(): Promise<void> {
    await Schema.create("mfa_methods", (table: Blueprint) => {
      table.string("id").primary();
      table.string("user_id");
      table.string("driver");
      table.text("secret").nullable();
      table.string("label").nullable();
      table.timestamp("confirmed_at").nullable();
      table.bigInteger("last_used_timestep").nullable();
      table.timestamp("created_at");

      // The enrollment lookup: "which confirmed methods does this user
      // have, for this driver?". Leading with `user_id` so the same
      // index also serves the driver-agnostic "is this user enrolled at
      // all?" query.
      table.index(["user_id", "driver"]);
    });
  },

  async down(): Promise<void> {
    await Schema.drop("mfa_methods");
  },
};

export default migration;
