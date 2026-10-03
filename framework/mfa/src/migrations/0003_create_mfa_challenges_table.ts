import { Schema, type Migration, type Blueprint } from "@mahiframework/database";

/**
 * `mfa_challenges`, one row per issued challenge.
 *
 * Only drivers that actually SEND something write here. TOTP and
 * recovery codes have nothing to issue (the user already holds the
 * factor), so an intent verified by either has no challenge row at all.
 *
 * A separate table rather than columns on `mfa_intents`, because a
 * resend means two live codes. Folding them into the intent would
 * silently invalidate the first the moment the second is sent, which is
 * defensible behaviour but should be a decision rather than a
 * consequence of the schema. Separate rows also leave the trail that
 * shows an account is being targeted.
 *
 * `code` is an argon2 hash. argon2 here, and SHA-256 for recovery
 * codes, is not an inconsistency: a 6-digit emailed code has ~20 bits
 * of entropy and is exactly what a slow hash exists to protect, while a
 * recovery code is 20 bytes from `randomBytes` and gains nothing from
 * one. See `token-hash.ts` in `@mahiframework/auth` for the same
 * reasoning applied to access tokens.
 *
 * `consumed_at` rather than deleting the row on use: a verify that
 * races a resend must be able to tell "already used" from "never
 * existed", and the row is swept by `mfa:gc` shortly after anyway.
 */
const migration: Migration = {
  async up(): Promise<void> {
    await Schema.create("mfa_challenges", (table: Blueprint) => {
      table.string("id").primary();
      table.string("intent_id");
      table.string("driver");
      table.string("code");
      table.integer("attempts").default(0);
      table.timestamp("sent_at").nullable();
      table.timestamp("expires_at");
      table.timestamp("consumed_at").nullable();
      table.timestamp("created_at");

      // "The live challenge for this intent", newest first.
      table.index(["intent_id", "created_at"]);
      // The GC sweep.
      table.index(["expires_at"]);
    });
  },

  async down(): Promise<void> {
    await Schema.drop("mfa_challenges");
  },
};

export default migration;
