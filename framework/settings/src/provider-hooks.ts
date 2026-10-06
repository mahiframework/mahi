import type { SettingDefinition } from "./setting-definition.js";

declare module "@mahiframework/core" {
  interface ProviderHooks {
    /**
     * Declare settings this provider owns: what each one is called, what
     * it holds, and what it is when nobody has set it.
     *
     *     settings(): SettingDefinition[] {
     *       return [
     *         {
     *           name: "import_feature_enabled",
     *           category: "import",
     *           type: "boolean",
     *           defaultValue: () => false,
     *         },
     *       ];
     *     }
     *
     * Collected during `SettingsServiceProvider.boot()`, which walks
     * every provider — so a provider listed *after* `SettingsServiceProvider`
     * in `config/app.ts` still has its definitions collected, the same
     * guarantee `models()` and `checks()` give.
     *
     * Names are unique across the whole application, not per category. A
     * duplicate throws `DuplicateSettingError` at boot rather than
     * letting one definition silently shadow another.
     */
    settings?(): SettingDefinition[];
  }
}
