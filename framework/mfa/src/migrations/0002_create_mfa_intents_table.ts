import { Schema, type Migration, type Blueprint } from "@mahiframework/database";

/**
 * `mfa_intents`, one step-up attempt and its outcome.
 *
 * TWO EXPIRY COLUMNS, because they answer different questions and one
 * cannot do both:
 *
 * - `intent_expires_at` bounds how long the user has to COMPLETE the
 *   challenge. Short. Set at creation. Without it an abandoned intent
 *   could be finished an hour later from a machine that has since
 *   changed hands.
 * - `verification_expires_at` bounds how long the PROOF stays good, the
 *   sudo window. Longer. Set at the moment of verification, not at
 *   creation, or the window would start when the user clicked rather
 *   than when they actually proved anything.
 *
 * `purpose` is nullable, and the matching rule is asymmetric: a generic
 * (null) requirement is satisfied by any verified intent, while a named
 * requirement is satisfied only by its exact match. Rolling specific up
 * to generic is safe (the user proved MORE than was asked); rolling
 * generic down to specific is not, which is the whole reason a
 * `requireMfa("billing.payout")` exists.
 *
 * `binding` ties the intent to one session or token, so a second
 * concurrent session for the same user cannot consume a verification it
 * never performed. Nullable, because a guard that exposes no
 * per-request identifier degrades to user-only matching rather than
 * failing.
 *
 * `attempts` lives here rather than in the cache: it avoids a
 * `@mahiframework/cache` dependency for one counter, and the row is
 * being written on every verify anyway.
 */
const migration: Migration = {
  async up(): Promise<void> {
    await Schema.create("mfa_intents", (table: Blueprint) => {
      table.string("id").primary();
      table.string("user_id");
      table.string("binding").nullable();
      table.string("purpose").nullable();
      table.string("status");
      table.string("driver").nullable();
      table.integer("attempts").default(0);
      table.timestamp("verified_at").nullable();
      table.timestamp("verification_expires_at").nullable();
      table.timestamp("intent_expires_at");
      table.timestamp("created_at");

      // The hot path: `requireMfa()` runs this on every guarded action,
      // looking for a live verified intent for one user.
      table.index(["user_id", "status", "verification_expires_at"]);
      // The GC sweep, and the "is there already a pending intent?"
      // lookup that stops a user accumulating them.
      table.index(["intent_expires_at"]);
    });
  },

  async down(): Promise<void> {
    await Schema.drop("mfa_intents");
  },
};

export default migration;
