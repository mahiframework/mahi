import { Schema, type Migration, type Blueprint } from "@mahiframework/database";

/**
 * `mfa_recovery_codes`, the way back in when the phone is gone.
 *
 * TOTP without these is a lockout generator: the secret lives on one
 * device, and losing that device means losing the account with no
 * self-service path. Shipping them as a driver rather than a special
 * case means "I lost my phone" goes through the same intent/verify
 * machinery as every other factor.
 *
 * `code` is a SHA-256 digest, NOT argon2. A recovery code is 20 bytes
 * of `randomBytes`, so there is no low-entropy keyspace to brute-force
 * and argon2's slowness buys nothing while costing a verify on every
 * attempt. Exactly the reasoning
 * `@mahiframework/auth`'s `token-hash.ts` records for access tokens,
 * and the same `hashToken`/`verifyTokenHash` pair is reused rather than
 * reimplemented.
 *
 * `used_at` rather than deleting on use: a user who has burned eight of
 * ten codes should be able to be told that, which is the signal to
 * regenerate.
 */
const migration: Migration = {
  async up(): Promise<void> {
    await Schema.create("mfa_recovery_codes", (table: Blueprint) => {
      table.string("id").primary();
      table.string("user_id");
      table.string("code");
      table.timestamp("used_at").nullable();
      table.timestamp("created_at");

      // "This user's unused codes", for both verification and the
      // "how many are left?" count.
      table.index(["user_id", "used_at"]);
    });
  },

  async down(): Promise<void> {
    await Schema.drop("mfa_recovery_codes");
  },
};

export default migration;
