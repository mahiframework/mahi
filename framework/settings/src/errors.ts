/**
 * The error family this package throws.
 *
 * One base class so an app can `catch (e) { if (e instanceof SettingsError) }`
 * without enumerating the subclasses, which is the shape every other
 * package here uses.
 */
export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A key nothing declared.
 *
 * Thrown by `get()` as well as `set()`. A typo in a setting name is
 * otherwise indistinguishable from "this setting has never been
 * customised", and the whole point of declaring settings up front is that
 * the registry knows the difference.
 */
export class UnknownSettingError extends SettingsError {
  constructor(readonly key: string) {
    super(
      `There is no setting named "${key}". Declare it in a provider's \`settings()\` hook before reading or writing it.`,
    );
  }
}

/**
 * Two definitions claimed the same name.
 *
 * Names are unique across the whole application, not per category, so
 * this catches the case `category` was never meant to disambiguate.
 * Thrown at boot rather than first use: a shadowed definition carries a
 * different type and default, so the failure would otherwise surface as
 * a validation error on an unrelated write.
 */
export class DuplicateSettingError extends SettingsError {
  constructor(readonly key: string) {
    super(
      `A setting named "${key}" is already defined. Setting names are unique across every category; rename one of them.`,
    );
  }
}

/**
 * A stored value that no longer decodes under its definition's type.
 *
 * Means a definition's `type` changed after a value was written, or the
 * row was edited outside this package. Thrown rather than silently
 * falling back to the default: a setting reading as its default when a
 * row says otherwise is a configuration change nobody asked for.
 */
export class SettingDecodeError extends SettingsError {
  constructor(
    readonly key: string,
    readonly type: string,
    readonly reason: string,
  ) {
    super(
      `The stored value for "${key}" is not a valid ${type}: ${reason}. Fix the row, or run \`settings:forget ${key}\` to revert it to its default.`,
    );
  }
}
