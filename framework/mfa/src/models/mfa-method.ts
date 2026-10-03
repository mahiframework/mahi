import { Cast, Model } from "@mahiframework/database";
import type { DateTime } from "@mahiframework/datetime";

/**
 * The framework-owned `mfa_methods` table. Owned by the package rather
 * than the app for the same reason `@mahiframework/auth` owns
 * `personal_access_tokens`: it is an internal detail of a built-in
 * driver, not application data.
 *
 * `secret` is ciphertext. It is never read directly off the model by
 * anything but the driver that owns it, which decrypts with the user id
 * as AAD.
 *
 * `last_used_timestep` is a plain integer rather than a `DateTime`: it
 * is an RFC 6238 step counter, and storing the derived timestamp would
 * mean converting back to a step on every verify and inviting an
 * off-by-one at the boundary.
 */
export interface MfaMethodAttributes {
  id: string;
  user_id: string;
  driver: string;
  /** AES-GCM ciphertext, or null for a driver that holds no secret. */
  secret: string | null;
  label: string | null;
  /** Null until a code generated from `secret` has been proved. */
  confirmed_at: DateTime | null;
  /** TOTP replay floor: the last step accepted for this method. */
  last_used_timestep: number | null;
  created_at: DateTime;
}

export class MfaMethod extends Model<MfaMethodAttributes>()({
  table: "mfa_methods",
  primaryKey: "id",
  timestamps: false,
  casts: {
    confirmed_at: Cast.datetime(),
    created_at: Cast.datetime(),
    last_used_timestep: Cast.integer(),
  },
  hidden: ["secret"],
}) {}
