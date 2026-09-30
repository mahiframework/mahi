/**
 * Tables the framework owns rather than an application's migrations, and
 * which a row-level wipe must therefore leave alone.
 *
 * `truncateAllTables()` empties user data but keeps the schema, so the
 * migration ledger has to survive with it: clearing `migrations` would
 * leave every table in place while the runner believed nothing had ever
 * run, so the next `migrate` would replay every migration against tables
 * that already exist and fail on the first `CREATE TABLE`.
 *
 * Kysely's own `withInternalKyselyTables` filter does not cover these —
 * it only knows `kysely_migration`/`kysely_migration_lock`, and this
 * framework names its ledger `migrations` (Laravel's convention).
 *
 * Declared here rather than in `migrator.ts` because the schema grammars
 * need them and `migrator.ts` already imports from `schema/`, so the
 * reverse direction would be a cycle.
 */
export const FRAMEWORK_TABLES: readonly string[] = ["migrations", "migrations_lock"];

/** Whether `truncateAllTables()` should skip this table. */
export function isFrameworkTable(name: string): boolean {
  return FRAMEWORK_TABLES.includes(name);
}
