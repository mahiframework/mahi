import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A per-request memo of each subject's raw assignments.
 *
 * This exists because of how the gate hook works, not as a general
 * optimisation. `GateRegistry.before()` callbacks run on EVERY
 * authorization check, so a controller doing five `can()` calls would
 * otherwise issue ten queries (roles and direct permissions, twice per
 * call) against rows that cannot have changed mid-request unless this
 * request changed them.
 *
 * Scoped rather than global for the obvious reason: a long-lived worker
 * process would otherwise serve one request's answers to the next, and
 * "why does this user still have admin" is not a bug anybody enjoys.
 *
 * The provider's `middleware()` pipe opens a scope per request. Outside
 * one, `assignmentMemo()` returns null and every read goes to the
 * database — correct by default, since a queue job or a CLI command has
 * no natural boundary at which the memo should expire. A job that wants
 * one wraps itself in `withPermissionCache()`.
 *
 * Writes through the registrar clear the memo rather than patching it:
 * patching means keeping two representations in step, and clearing costs
 * one query on the next check.
 */
export interface AssignmentRecord {
  roleIds: bigint[];
  permissionIds: bigint[];
}

const storage = new AsyncLocalStorage<Map<string, AssignmentRecord>>();

/** Run `fn` inside a memo scope. Called once per request by the provider's pipe. */
export function runWithPermissionCache<T>(fn: () => T): T {
  return storage.run(new Map<string, AssignmentRecord>(), fn);
}

/**
 * Open a memo scope around a job, command, or test.
 *
 * Async-returning so a caller cannot forget to await it, and so the scope
 * genuinely covers the whole callback rather than just its synchronous
 * prefix.
 */
export function withPermissionCache<T>(callback: () => T | Promise<T>): Promise<T> {
  return storage.run(new Map<string, AssignmentRecord>(), async () => callback());
}

/** The active memo, or null outside a scope. */
export function assignmentMemo(): Map<string, AssignmentRecord> | null {
  return storage.getStore() ?? null;
}

/**
 * Drop memoised assignments.
 *
 * With no argument, clears everything: a role's permissions changing
 * affects every subject holding it, and the registrar has no index from
 * role to subject. Pass a key to drop just one subject, which is what an
 * assignment write does.
 */
export function forgetMemoisedAssignments(cacheKey?: string): void {
  const memo = storage.getStore();

  if (memo === undefined) {
    return;
  }

  if (cacheKey === undefined) {
    memo.clear();

    return;
  }

  memo.delete(cacheKey);
}
