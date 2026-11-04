import type { SettingsService } from "@ace/settings";
import type { LazyDevices } from "./lazy-devices.ts";

/**
 * Keeps devices and the saved `devices.enabled` in step: devices start as the setting says, a
 * change in Settings turns them on or off, and turning them on from a thread's Devices tab is
 * saved too, so the choice outlasts a restart. Unset means on.
 */
export async function followDevicesSetting(
  devices: LazyDevices,
  settings: Pick<SettingsService, "get" | "set" | "subscribe">,
  log: (error: unknown) => void,
): Promise<() => void> {
  const apply = (value: unknown) => {
    void devices.setEnabled(value !== false).catch(log);
  };
  const release = await settings.subscribe({ keys: ["devices.enabled"], scope: {} }, (event) => {
    if (event.type !== "changed") return;
    const entry = event.entries.find((each) => each.key === "devices.enabled");
    if (entry) apply(entry.value);
  });
  apply((await settings.get("devices.enabled")).value);
  const stopWatching = devices.watchEnabled((enabled) => {
    void settings
      .get("devices.enabled")
      .then(({ value }) =>
        (value !== false) === enabled
          ? undefined
          : settings.set("devices.enabled", enabled, { kind: "global" }),
      )
      .catch(log);
  });
  return () => {
    stopWatching();
    release();
  };
}
