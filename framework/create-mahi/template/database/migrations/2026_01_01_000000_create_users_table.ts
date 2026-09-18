import { Schema, type Migration, type Blueprint } from "@mahiframework/database";

/**
 * App-owned users table, add your own columns here freely; nothing in
 * `@mahiframework/auth` depends on this shape beyond the two columns named in
 * `config/auth.ts` (`identifierColumn`, `passwordColumn`).
 *
 * The framework's own tables (`personal_access_tokens`, `sessions`,
 * `password_reset_tokens`, `jobs`, `failed_jobs`, `notifications`) are
 * contributed by their packages' `migrations()` hooks and run alongside
 * this one. They are not copied into your app.
 */
const migration: Migration = {
  async up(): Promise<void> {
    await Schema.create("users", (table: Blueprint) => {
      // Snowflakes are 64-bit, see `keyType` on the `User` model.
      table.bigInteger("id").primary();
      table.string("name");
      table.string("email").unique();
      table.string("password");
      // Null until the user clicks their verification link. Opting into
      // email verification is exactly this column plus the
      // `ensureEmailVerified()` middleware on the routes that require it.
      // There is no interface to implement.
      table.timestamp("email_verified_at").nullable();
      table.timestamps();
      table.softDeletes();
    });
  },

  async down(): Promise<void> {
    await Schema.drop("users");
  },
};

export default migration;
