import { Schema, type Migration, type Blueprint } from "@mahiframework/database";

/**
 * `personal_access_tokens` backing `TokenGuard`.
 *
 * `token` stores a SHA-256 digest, never the plaintext secret, a leaked
 * database dump therefore yields no usable credentials. The primary key
 * is the token id that clients send as the `"<id>|<secret>"` prefix, so
 * authenticating a request is one indexed PK lookup (see `token-hash.ts`
 * for why that prefix matters).
 *
 * `user_id` is indexed for `revokeAllTokens()` ("log this user out
 * everywhere"). No foreign key to `users`: that table is app-owned and
 * the framework can't assume its name.
 */
const migration: Migration = {
  async up(): Promise<void> {
    await Schema.create("personal_access_tokens", (table: Blueprint) => {
      table.string("id").primary();
      table.bigInteger("user_id").index();
      table.string("name");
      table.string("token");
      table.timestamp("last_used_at").nullable();
      table.timestamp("expires_at").nullable();
      table.timestamp("created_at");
    });
  },

  async down(): Promise<void> {
    await Schema.drop("personal_access_tokens");
  },
};

export default migration;
