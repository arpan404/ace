/** Settings: every page, its navigation and the theme editor. */
export {
  AdvancedSettingsScreen,
  AgentsSettingsScreen,
  StorageSettingsScreen,
  BrowserSettingsScreen,
  PairDeviceScreen,
  PromptsSettingsScreen,
  AppearanceSettingsScreen,
  ComputerUseSettingsScreen,
  GeneralSettingsScreen,
  KeyboardSettingsScreen,
  NotificationSettingsScreen,
  ProviderDetailScreen,
  ProviderSettingsScreen,
  RemoteSettingsScreen,
  FleetMachineScreen,
  SourceControlSettingsScreen,
  SettingsIndexScreen,
} from "./settings-screens.tsx";
/** Every setting by page, for the palette's Settings group and the Settings filter (ST-05). */
export { pageTitle, searchSettings, settingsIndex, type SettingEntry } from "./settings-index.ts";
export { SettingsNav } from "./settings-nav.tsx";
/** Which machine the Machine pages edit, and the routed page rendered against it. */
export { SettingsMachineProvider } from "./machine-scope.tsx";
export { SettingsOutlet } from "./settings-outlet.tsx";
/** One daemon setting as live state, for slices that edit a setting outside Settings. */
export { useSetting } from "./data/use-settings.ts";
export { settingKeys } from "./data/setting-keys.ts";
export type { LimitPolicy } from "./data/setting-keys.ts";
