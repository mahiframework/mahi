import { Cast, Model } from "@mahiframework/database";
import type { DateTime } from "@mahiframework/datetime";

/**
 * The framework-owned `mfa_recovery_codes` table.
 *
 * `code` is a SHA-256 digest (see the migration for why not argon2) and
 * is hidden from serialisation. The plaintext set exists exactly once,
 * in the return value of `generateRecoveryCodes()`; there is no way to
 * read it back afterwards, which is the property that makes "we cannot
 * show you these again" true rather than a UI convention.
 */
export interface MfaRecoveryCodeAttributes {
  id: string;
  user_id: string;
  /** SHA-256 digest of the code, never the plaintext. */
  code: string;
  /** Single use: set the first time this code verifies. */
  used_at: DateTime | null;
  created_at: DateTime;
}

export class MfaRecoveryCode extends Model<MfaRecoveryCodeAttributes>()({
  table: "mfa_recovery_codes",
  primaryKey: "id",
  timestamps: false,
  casts: {
    used_at: Cast.datetime(),
    created_at: Cast.datetime(),
  },
  hidden: ["code"],
}) {}
