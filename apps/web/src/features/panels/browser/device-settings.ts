import { DeviceSettings, type TabDevice } from "@ace/ui-core/browser-device-settings";
import { useCallback, useSyncExternalStore } from "react";
import { useLayout } from "@/lib/layout.tsx";

export type { TabDevice };

const stores = new WeakMap<object, DeviceSettings>();
let unstored: DeviceSettings | undefined;

/** This app's device toolbar settings, made once per storage. */
export function useDeviceSettings(): DeviceSettings {
  const { storage } = useLayout();
  if (!storage) return (unstored ??= new DeviceSettings(undefined));
  let store = stores.get(storage);
  if (!store) {
    store = new DeviceSettings(storage);
    stores.set(storage, store);
  }
  return store;
}

/** A tab's device toolbar settings, kept current. */
export function useTabDevice(threadId: string, tabId: string | undefined) {
  const store = useDeviceSettings();
  const read = useCallback(
    () => (tabId ? store.tab(threadId, tabId) : undefined),
    [store, threadId, tabId],
  );
  const device = useSyncExternalStore(store.subscribe, read);
  const update = useCallback(
    (patch: Partial<TabDevice>) => {
      if (tabId) store.update(threadId, tabId, patch);
    },
    [store, threadId, tabId],
  );
  const preview = useCallback(
    (patch: Partial<TabDevice>) => {
      if (tabId) store.preview(threadId, tabId, patch);
    },
    [store, threadId, tabId],
  );
  return { device, update, preview };
}

/** "Always show in new tabs", kept current. */
export function useAlwaysShowDevices(): [boolean, (value: boolean) => void] {
  const store = useDeviceSettings();
  const always = useSyncExternalStore(store.subscribe, store.always);
  return [always, (value) => store.setAlways(value)];
}
