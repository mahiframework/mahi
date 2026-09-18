import { randomUUID } from "node:crypto";
import type { DatabaseManager } from "@mahiframework/database";
import type { NotificationChannel } from "../notification-channel.js";
import type { Notification } from "../notification.js";
import type { NotificationRoutable } from "../notifiable.js";

/**
 * The shape `DatabaseChannel` needs from a notifiable's CLASS to name it
 * in the `notifiable_type` column.
 *
 * `morphAlias()` is what every `Model` exposes (morph map → `morphName` →
 * `table`), so a notifiable that IS a model needs nothing extra and
 * agrees with whatever a `morphMany`/`morphTo` on the same table would
 * write. `table` remains accepted for the plain-adapter notifiables the
 * guide documents, classes that implement `NotificationRoutable` without
 * extending `Model`, which have no `morphAlias()` to call.
 */
interface NotifiableClass {
  morphAlias?: () => string;
  table?: string;
}

/**
 * Reads the notifiable's class off the **prototype**, not
 * `instance.constructor`.
 *
 * A live `Model` is `Proxy`-wrapped and its `get` trap binds every
 * function-valued property it returns, including `constructor`, and a
 * bound function carries none of the original's statics. So
 * `instance.constructor.table` reads `undefined` for a real model, which
 * is exactly the trap `ModelRegistry.nameFor()` and `loadMany()` document.
 * The prototype's own `constructor` is the unwrapped class.
 */
function notifiableClassOf(notifiable: NotificationRoutable): NotifiableClass {
  return Object.getPrototypeOf(notifiable).constructor as NotifiableClass;
}

/**
 * Persists a notification's `toDatabase()` payload into the generic
 * `notifications` table, so a notifiable can list its unread notifications
 * later (an in-app "notification bell").
 *
 * The table carries an explicit `notifiable_type` + `notifiable_id` pair,
 * written by a manual insert here rather than through a relation. The
 * row is created before anything would read it back as one, and the
 * insert needs no relation machinery.
 *
 * `notifiable_type` comes from the notifiable class's `morphAlias()`
 * (`@mahiframework/database`'s morph-map → `morphName` → `table` chain), so a
 * notifiable that's a real `Model` writes the same discriminant a
 * `morphMany`/`morphTo` against the same table would. Which is what
 * makes `Notification`'s own `notifiable` relation resolve. Plain adapter
 * classes that implement `NotificationRoutable` without extending `Model`
 * fall back to their static `table`.
 *
 * `notifiable_id` comes from `routeNotificationFor("database")`.
 *
 * `DatabaseManager` is an explicit constructor dependency (resolved once by
 * the channel factory), mirroring `MailChannel`.
 */
export class DatabaseChannel implements NotificationChannel {
  constructor(private db: DatabaseManager) {}

  async send(notifiable: NotificationRoutable, notification: Notification): Promise<void> {
    if (!notification.toDatabase) {
      return;
    }

    const notifiableType = this.resolveNotifiableType(notifiable);
    const now = new Date().toISOString();

    await this.db
      .connection()
      .kysely.insertInto("notifications")
      .values({
        id: notification.id ?? randomUUID(),
        type: notification.databaseType(),
        notifiable_type: notifiableType,
        notifiable_id: notifiable.routeNotificationFor("database") as string,
        // A notification's data routinely carries a model id, which is
        // 64-bit and so a `bigint` that `JSON.stringify` throws on.
        data: JSON.stringify(notification.toDatabase(notifiable), (_key, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
        read_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  /**
   * The discriminant to store for this notifiable, `morphAlias()` when
   * the class has one (every `Model` does), else its static `table`.
   *
   * Note `morphAlias()` can itself throw `ClassMorphViolationError` under
   * `Relation.requireMorphMap()`. That's deliberate and not caught here:
   * enforcement exists precisely so an unregistered model fails loudly
   * instead of silently writing a table name nothing will resolve later.
   */
  private resolveNotifiableType(notifiable: NotificationRoutable): string {
    const notifiableClass = notifiableClassOf(notifiable);

    if (typeof notifiableClass.morphAlias === "function") {
      return notifiableClass.morphAlias();
    }

    if (notifiableClass.table) {
      return notifiableClass.table;
    }

    throw new Error(
      "The database channel requires the notifiable's class to expose either a `morphAlias()` " +
        "(every @mahiframework/database Model does) or a static `table` name.",
    );
  }
}
