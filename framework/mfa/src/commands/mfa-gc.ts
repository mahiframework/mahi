import { Command } from "@mahiframework/cli";
import { DateTime } from "@mahiframework/datetime";
import { MfaChallenge } from "../models/mfa-challenge.js";
import { Mfa } from "../mfa-facade.js";

/**
 * Delete spent MFA intents and challenges.
 *
 * Every read path enforces expiry, so a stale row is never HONOURED,
 * but nothing deletes them either and both tables grow without bound.
 * Same rationale, and same naming, as `auth:gc`. Schedule it; it is
 * cleanup, not a correctness guarantee.
 *
 * Consumed challenges are swept too, not just expired ones: a consumed
 * row exists only so a verify racing a resend can tell "already used"
 * from "never existed", and that distinction stops mattering once the
 * intent it belonged to is gone.
 */
export class MfaGcCommand extends Command {
  signature = "mfa:gc";
  description = "Delete expired MFA intents and challenges.";

  async handle(): Promise<void> {
    const intents = await Mfa.instance().gc();
    this.app.logger.info(`mfa:gc removed ${intents} spent MFA intent(s).`);

    const now = DateTime.now();
    const challenges = await MfaChallenge.query().where("expires_at", "<=", now).delete();
    const consumed = await MfaChallenge.query().whereNotNull("consumed_at").delete();

    this.app.logger.info(`mfa:gc removed ${challenges + consumed} spent MFA challenge(s).`);
  }
}
