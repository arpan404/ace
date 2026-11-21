import { desktopDeviceTabs, type DeviceTabState } from "@/boot/desktop-device-tabs.ts";

/*
 * Every device tab's last state from the desktop, by tab id, as an external store. Subscribes to
 * the bridge once, on first use.
 */

const states = new Map<string, DeviceTabState>();
const listeners = new Map<string, Set<() => void>>();
let listening = false;

function listen() {
  if (listening) return;
  const tabs = desktopDeviceTabs();
  if (!tabs) return;
  listening = true;
  tabs.onState((state) => {
    states.set(state.tabId, state);
    for (const listener of listeners.get(state.tabId) ?? []) listener();
  });
}

export function subscribeDeviceTab(tabId: string, changed: () => void): () => void {
  listen();
  let set = listeners.get(tabId);
  if (!set) listeners.set(tabId, (set = new Set()));
  set.add(changed);
  return () => {
    set.delete(changed);
    if (set.size === 0) listeners.delete(tabId);
  };
}

export function deviceTabStateOf(tabId: string): DeviceTabState | undefined {
  return states.get(tabId);
}

/** The tab closed: its state goes with it. */
export function forgetDeviceTab(tabId: string): void {
  states.delete(tabId);
}
