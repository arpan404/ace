/** Devices: the daemon's iOS Simulators and Android emulators, a catalog and a tab per device. */
export { DevicesTab } from "./devices-tab.tsx";
export { DeviceTab } from "./device-tab.tsx";
export { DownloadDeviceTools } from "./download-tools.tsx";
export {
  clearDeviceUses,
  setScreenOnly,
  setStreamStatsShown,
  useRecentUses,
  useScreenOnly,
  useStreamStatsShown,
} from "./device-prefs.ts";
