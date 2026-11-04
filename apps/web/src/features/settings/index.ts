/** Settings: every page, its navigation and the theme editor. */
export {
  AdvancedSettingsScreen,
  AgentsSettingsScreen,
  StorageSettingsScreen,
  BrowserSettingsScreen,
  DevicesSettingsScreen,
  PairDeviceScreen,
  PromptsSettingsScreen,
  AppearanceSettingsScreen,
  ComputerUseSettingsScreen,
  GeneralSettingsScreen,
  ProfileSettingsScreen,
  KeyboardSettingsScreen,
  NotificationSettingsScreen,
  ProviderDetailScreen,
  ProviderSettingsScreen,
  RemoteSettingsScreen,
  FleetMapScreen,
  FleetMachineScreen,
  SourceControlSettingsScreen,
  SettingsIndexScreen,
} from "./settings-screens.tsx";
/** Every setting by page, for the palette's Settings group and the Settings filter (ST-05). */
export {
  entryRoute,
  pageTitle,
  searchSettings,
  settingsIndex,
  type SettingEntry,
} from "./settings-index.ts";
export { SettingsNav } from "./settings-nav.tsx";
/** Which machine the Machine pages edit, and the routed page rendered against it. */
export { SettingsMachineProvider } from "./machine-scope.tsx";
export { SettingsOutlet } from "./settings-outlet.tsx";
/** One daemon setting as live state, for slices that edit a setting outside Settings. */
export { useSetting } from "./data/use-settings.ts";
/** A machine's fleet links, read through its own client (ADR 0078). */
export { fleetKeys, machineLinks } from "./data/fleet.ts";
export { settingKeys } from "./data/setting-keys.ts";
export type { LimitPolicy } from "./data/setting-keys.ts";
/** Settings in a window with no machine: Profile and Fleet only. */
export {
  NoMachineFleetScreen,
  NoMachineProfileScreen,
  NoMachineSettingsNav,
} from "./no-machine-settings.tsx";
