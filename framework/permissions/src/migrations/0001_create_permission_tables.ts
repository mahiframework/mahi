import { Schema, type Migration, type Blueprint } from "@mahiframework/database";

/**
 * All five permission tables in one migration, mirroring spatie's single
 * `create_permission_tables`.
 *
 * One unit rather than five because the three pivots are meaningless
 * without the two entity tables, and a partial rollback that left
 * `model_has_roles` pointing at a dropped `roles` would be a worse state
 * than either end of the migration.
 *
 * `roles` and `permissions` are identical in shape and deliberately kept
 * as separate tables rather than one table with a `kind` column: the two
 * are joined to each other (`role_has_permissions`), so a single table
 * would need a self-referential pivot and every query would carry a
 * `kind` predicate that the schema should have made impossible.
 *
 * `guard_name` is NOT NULL on both, and `(name, guard_name)` is unique.
 * There is no "applies to every guard" value: a nullable `guard_name`
 * cannot be made unique portably, because every engine treats NULLs as
 * distinct in a unique index and the fix (`nullsNotDistinct`) is Postgres
 * 15+ only and throws on SQLite/MySQL. Nullable would therefore have
 * allowed unlimited duplicate `('admin', NULL)` rows, which is exactly
 * the integrity this table exists to have.
 *
 * `id` on both is an auto-increment `bigIncrements` primary key, so the
 * keys are assigned by the database. The pivots' `role_id`/
 * `permission_id`/`model_id` stay `bigInteger` to match.
 *
 * COMPOSITE PRIMARY KEYS, not surrogate ids, on all three pivots. They
 * ARE the dedupe mechanism: nothing in the framework deduplicates pivot
 * inserts, so "assign the same role twice" has to be either a database
 * error or a diffed write, and the constraint is what makes the first
 * possible. `model_has_*` leads with the foreign id so the index also
 * serves "who holds this role", with a second index on
 * `(model_id, model_type)` for the far commoner "what does this subject
 * hold".
 *
 * FOREIGN KEYS ON THE PACKAGE-OWNED SIDE ONLY. `role_id` and
 * `permission_id` cascade on delete, because both tables are this
 * package's and deleting a role must not leave assignments behind.
 * `model_id` carries no foreign key at all: `users` is app-owned so the
 * framework cannot assume its name, and the column holds the key of any
 * assignable model. Same reasoning as `activity_logs.model_id` and
 * `sessions.user_id`.
 *
 * `model_id` is a `bigInteger`, NOT text, which is the one place this
 * schema diverges from `activity_logs`/`notifications`. Those tables are
 * only ever read back by equality from code that already knows the type,
 * so text (which holds every key type losslessly) costs them nothing.
 * Here the column is the local side of a `morphToMany` pivot, and
 * `buildPivotQuery()` binds the local key value RAW — a `bigint` against
 * a `varchar` column makes Postgres raise `operator does not exist`. Text
 * would therefore have broken the exported relation helpers, and with
 * them `with("roles")` and `whereHas("roles", ...)`. The cost is that
 * only integer-keyed models can hold roles, which
 * `resolveAssignee()` enforces with a clear error rather than letting it
 * reach SQL.
 *
 * No timestamps on the pivots. spatie has none either, and there is
 * nothing to record: the composite key carries the entire fact.
 */
const migration: Migration = {
  async up(): Promise<void> {
    await Schema.create("roles", (table: Blueprint) => {
      table.bigIncrements("id");
      table.string("name");
      table.string("guard_name");
      table.timestamp("created_at");
      table.timestamp("updated_at");
      table.unique(["name", "guard_name"]);
    });

    await Schema.create("permissions", (table: Blueprint) => {
      table.bigIncrements("id");
      table.string("name");
      table.string("guard_name");
      table.timestamp("created_at");
      table.timestamp("updated_at");
      table.unique(["name", "guard_name"]);
    });

    await Schema.create("role_has_permissions", (table: Blueprint) => {
      table.bigInteger("role_id");
      table.bigInteger("permission_id");
      table.primary(["role_id", "permission_id"]);
      table.foreign("role_id").references("id").on("roles").cascadeOnDelete();
      table.foreign("permission_id").references("id").on("permissions").cascadeOnDelete();
    });

    await Schema.create("model_has_roles", (table: Blueprint) => {
      table.bigInteger("role_id");
      table.string("model_type");
      table.bigInteger("model_id");
      table.primary(["role_id", "model_id", "model_type"]);
      table.index(["model_id", "model_type"]);
      table.foreign("role_id").references("id").on("roles").cascadeOnDelete();
    });

    await Schema.create("model_has_permissions", (table: Blueprint) => {
      table.bigInteger("permission_id");
      table.string("model_type");
      table.bigInteger("model_id");
      table.primary(["permission_id", "model_id", "model_type"]);
      table.index(["model_id", "model_type"]);
      table.foreign("permission_id").references("id").on("permissions").cascadeOnDelete();
    });
  },

  /** Reverse creation order, so a pivot never outlives the table it references. */
  async down(): Promise<void> {
    await Schema.drop("model_has_permissions");
    await Schema.drop("model_has_roles");
    await Schema.drop("role_has_permissions");
    await Schema.drop("permissions");
    await Schema.drop("roles");
  },
};

export default migration;
