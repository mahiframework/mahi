import { Command } from "@mahiframework/cli";
import { Impersonation } from "../impersonation-facade.js";

/**
 * Delete impersonation rows whose session has lapsed.
 *
 * A row is only reachable through a live session id, so a stale one is
 * never *honoured*, but nothing deletes it either and the table would grow
 * unboundedly. Cleanup, not a correctness guarantee, the same contract
 * `auth:gc` has. Schedule it alongside that one.
 *
 * Kept separate from `auth:gc` rather than folded into it: that command
 * sweeps guards by capability within `@mahiframework/auth`, and reaching
 * across into another package's table would invert the dependency.
 */
export class ImpersonationGcCommand extends Command {
  signature = "impersonation:gc";
  description = "Delete impersonation records whose session has expired.";

  async handle(): Promise<void> {
    const removed = await Impersonation.instance().gc();

    this.app.logger.info(`impersonation:gc removed ${removed} expired impersonation record(s).`);
  }
}
