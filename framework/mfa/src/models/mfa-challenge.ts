import { Cast, Model } from "@mahiframework/database";
import type { DateTime } from "@mahiframework/datetime";

/**
 * The framework-owned `mfa_challenges` table: one issued credential.
 *
 * Only written by drivers that send something. `code` is an argon2 hash
 * and is never serialised, so a challenge rendered into an API response
 * cannot leak the thing it is protecting.
 */
export interface MfaChallengeAttributes {
  id: string;
  intent_id: string;
  driver: string;
  /** argon2 hash of the issued code, never the plaintext. */
  code: string;
  attempts: number;
  sent_at: DateTime | null;
  expires_at: DateTime;
  /** Set on a successful verify; the row is kept so a replay is distinguishable. */
  consumed_at: DateTime | null;
  created_at: DateTime;
}

export class MfaChallenge extends Model<MfaChallengeAttributes>()({
  table: "mfa_challenges",
  primaryKey: "id",
  timestamps: false,
  casts: {
    attempts: Cast.integer(),
    sent_at: Cast.datetime(),
    expires_at: Cast.datetime(),
    consumed_at: Cast.datetime(),
    created_at: Cast.datetime(),
  },
  hidden: ["code"],
}) {}
