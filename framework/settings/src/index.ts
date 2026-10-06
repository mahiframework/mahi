export { SettingsServiceProvider, SETTINGS_TOKEN } from "./settings-service-provider.js";
export { Setting } from "./settings-facade.js";
export { SettingsRegistry } from "./settings-registry.js";

export { SettingRecord } from "./models/setting-record.model.js";
export type { SettingRecordAttributes } from "./models/setting-record.model.js";

export type {
  AppSettings,
  InferSettingType,
  SettingActor,
  SettingDefinition,
  SettingKey,
  SettingType,
  SettingValue,
} from "./setting-definition.js";

export { resolveConfig } from "./settings-config.js";
export type {
  ResolvedSettingsConfig,
  SettingsCacheConfig,
  SettingsConfig,
} from "./settings-config.js";

export { SettingUpdated } from "./events/setting-updated.js";

export { InvalidateSettingsCacheListener } from "./listeners/invalidate-settings-cache.listener.js";

export { SettingsCacheResetCommand } from "./commands/settings-cache-reset.js";
export { SettingsForgetCommand } from "./commands/settings-forget.js";
export { SettingsGetCommand } from "./commands/settings-get.js";
export { SettingsListCommand } from "./commands/settings-list.js";
export { SettingsSetCommand } from "./commands/settings-set.js";

// The codec's `display` is exported for an app building its own admin
// screen or command, which needs the same "render a value for a human"
// rule the built-in commands use. `encode`/`decode`/`typeRule` are not:
// they are the storage boundary and have no caller outside the registry.
export { display } from "./value-codec.js";

export {
  DuplicateSettingError,
  SettingDecodeError,
  SettingsError,
  UnknownSettingError,
} from "./errors.js";

import "./provider-hooks.js";
