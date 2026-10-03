import { Cast, Model } from "@mahiframework/database";
import type { DateTime } from "@mahiframework/datetime";

/**
 * One link in an impersonation chain: a row of the framework-owned
 * `impersonations` table, keyed by the session that link created.
 *
 * "Link" rather than "Impersonation" because the facade owns that name,
 * and because a row genuinely is one hop of a possibly-nested chain
 * (Bob → Alice → Jane is two links). The table stays `impersonations`.
 *
 * A row exists only while the impersonation does: `stop()` deletes it and
 * `impersonation:gc` sweeps rows whose session has lapsed. So "is this
 * session an impersonation?" is one lookup by `session_id`, and revoking
 * one out of band is one delete, the same revocability that makes
 * server-side rows the right home for auth state.
 *
 * `id` is a client-generated random string supplied on every write, so no
 * key strategy is needed. `timestamps: false`: there is no `updated_at`,
 * and `created_at` is hand-stamped.
 */
export interface ImpersonationRecord {
  id: string;
  /**
   * The session this link CREATED, not the one it replaced (that session
   * was destroyed by `login()`). Unique: a session is at most one
   * impersonation. Rewritten when a nested link unwinds and its parent
   * takes over the newly created session.
   */
  session_id: string;
  /** Who started this link. Text, see the migration. */
  impersonator_id: string;
  /** Who is being impersonated. */
  impersonated_id: string;
  /** The enclosing link for a nested impersonation, else null. */
  parent_id: string | null;
  /** 1 for a direct impersonation, 2 for one nested inside it, and so on. */
  depth: number;
  /**
   * Whether the session this link REPLACED was a long-lived
   * ("remember me") one, so `stop()` can restore it in kind.
   *
   * Stored rather than recomputed because the evidence is gone by then:
   * the replaced session's row is deleted at `start()`, and remember-me
   * leaves no other trace (no `remember_token`, no second cookie, just a
   * longer expiry). Derived at `start()` by comparing that expiry against
   * the guard's ordinary lifetime.
   */
  remembered: boolean;
  created_at: DateTime;
  /**
   * Mirrors the created session's own expiry, so `gc()` can sweep lapsed
   * links without joining to `sessions`.
   */
  expires_at: DateTime;
}

export class ImpersonationLink extends Model<ImpersonationRecord>()({
  table: "impersonations",
  primaryKey: "id",
  timestamps: false,
  casts: {
    remembered: Cast.boolean(),
    created_at: Cast.datetime(),
    expires_at: Cast.datetime(),
  },
}) {}
