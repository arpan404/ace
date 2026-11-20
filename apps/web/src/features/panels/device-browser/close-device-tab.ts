import { desktopDeviceTabs } from "@/boot/desktop-device-tabs.ts";
import { forgetDeviceTab } from "./device-store.ts";

/** A device tab's panel tab closed: its native view goes too. */
export function closeDeviceTab(tabId: string): void {
  forgetDeviceTab(tabId);
  void desktopDeviceTabs()?.close(tabId);
}
