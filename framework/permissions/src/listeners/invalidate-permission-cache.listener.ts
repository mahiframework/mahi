import type { Application } from "@mahiframework/core";
import type { Listener } from "@mahiframework/events";
import type { ModelLifecycleEvent } from "@mahiframework/database";
import { PermissionRegistrar } from "../permission-registrar.js";
import { PERMISSIONS_TOKEN } from "../tokens.js";
import { Permission } from "../models/permission.model.js";
import { Role } from "../models/role.model.js";

/**
 * Forgets the cached role/permission map when a `Role` or `Permission`
 * row is written outside this package.
 *
 * `PermissionRegistrar` already forgets the cache on every write it
 * performs, so this listener exists entirely for the writes it never
 * sees: a seeder calling `Role.create(...)`, a migration backfilling
 * `guard_name`, an admin screen saving a renamed role through the model.
 * Without it, the map would keep answering from the old names until the
 * TTL expired — which is precisely the class of bug a permission system
 * cannot ship with.
 *
 * Subscribed to the three past-tense classes individually, not a
 * `"model.*"` pattern. The pattern would also match `retrieved`, which
 * fires on every row read in the application, so this would sit on the
 * hottest path only to filter itself out. `ModelSaved` is skipped: it
 * fires alongside both `ModelCreated` and `ModelUpdated` and would
 * double the work. `ModelRestored` is skipped too — neither model uses
 * soft deletes, so it cannot fire for them.
 *
 * ## Errors are not swallowed
 *
 * `EventDispatcher` awaits listeners with no isolation and
 * `dispatchModelEvent` is awaited inside `save()`, so a throw here fails
 * the caller's `Role.create()`. That is the right trade, and the opposite
 * of the one `activity-logs` makes: a missing audit row is a lost record,
 * but a cache that still grants a deleted role's permissions is a
 * security failure. Better the write fails loudly and is retried than
 * succeeds while leaving the cache lying.
 */
export class InvalidatePermissionCacheListener implements Listener<ModelLifecycleEvent> {
  constructor(private readonly app: Application) {}

  async handle(event: ModelLifecycleEvent): Promise<void> {
    // Identity, not `morphAlias()`: an app may legitimately map `Role` to
    // some other alias, and the question here is only whether the row
    // that moved belongs to one of the two tables this cache is built
    // from.
    if (event.model !== (Role as never) && event.model !== (Permission as never)) {
      return;
    }

    await this.app.make<PermissionRegistrar>(PERMISSIONS_TOKEN).forgetCache();
  }
}
