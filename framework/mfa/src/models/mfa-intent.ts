import { Cast, Model } from "@mahiframework/database";
import type { DateTime } from "@mahiframework/datetime";

/**
 * The framework-owned `mfa_intents` table: one step-up attempt.
 *
 * `status` is a string column rather than a database enum, matching how
 * the rest of the framework stores discriminants: an enum is a schema
 * migration to extend, and the set is owned by this package's code.
 */
export type MfaIntentStatus = "pending" | "verified" | "locked";

export interface MfaIntentAttributes {
  id: string;
  user_id: string;
  /** Session or token id this intent belongs to; null when unbindable. */
  binding: string | null;
  /** Null means a generic step-up. See the matching rule in `requireMfa`. */
  purpose: string | null;
  status: MfaIntentStatus;
  /** Chosen on the first `challenge()`; null while the user is still picking. */
  driver: string | null;
  attempts: number;
  verified_at: DateTime | null;
  /** The sudo window. Only set once `verified_at` is. */
  verification_expires_at: DateTime | null;
  /** Deadline to verify at all. Set at creation. */
  intent_expires_at: DateTime;
  created_at: DateTime;
}

export class MfaIntent extends Model<MfaIntentAttributes>()({
  table: "mfa_intents",
  primaryKey: "id",
  timestamps: false,
  casts: {
    attempts: Cast.integer(),
    verified_at: Cast.datetime(),
    verification_expires_at: Cast.datetime(),
    intent_expires_at: Cast.datetime(),
    created_at: Cast.datetime(),
  },
}) {}
