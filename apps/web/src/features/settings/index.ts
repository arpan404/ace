/** Settings: every page, its navigation and the theme editor. */
export {
  AdvancedSettingsScreen,
  BetaSettingsScreen,
  AgentsSettingsScreen,
  StorageSettingsScreen,
  BrowserSettingsScreen,
  SimulatorsSettingsScreen,
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
  FleetMachineAppsScreen,
  FleetAcrossScreen,
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
export { AccountMachines, AddMachineDialog, type MachineWay } from "./no-machine-fleet.tsx";

/** A Settings page's frame: its title, lede and actions around the body (other slices' pages use it). */
export { SettingsBody } from "./settings-body.tsx";
/** The ace window in miniature in a look, for previews outside Settings (a Suit in the marketplace). */
export { AppPreview } from "./app-preview.tsx";
/** This computer's daemon's account controls, for a slice that signs it in again (the marketplace). */
export { useMachineAccountAccess } from "./machine-account.tsx";
