import { BrowserWindow, type WebContents } from "electron";
import type { Handlers } from "../ipc.ts";
import type { DeviceTabHost, DeviceTabs } from "./device-tabs.ts";

type DeviceTabChannel = "deviceTab.open" | "deviceTab.place" | "deviceTab.go" | "deviceTab.close";

const hostOf = (sender: WebContents | undefined): DeviceTabHost | undefined => {
  const window = sender && BrowserWindow.fromWebContents(sender);
  return sender && window ? { contents: sender, window, zoom: sender.getZoomFactor() } : undefined;
};

/** The bridge's `deviceTab.*` requests, for the app window that asks. */
export function deviceTabHandlers(tabs: DeviceTabs): Pick<Handlers, DeviceTabChannel> {
  return {
    "deviceTab.open": async (request, sender) => {
      const host = hostOf(sender);
      if (!host) throw new Error("No window to open the tab in");
      await tabs.open(request, host);
      return undefined;
    },
    "deviceTab.place": (request, sender) => {
      const host = hostOf(sender);
      return host ? tabs.place(request, host) : "unavailable";
    },
    "deviceTab.go": (request) => tabs.go(request),
    "deviceTab.close": (request) => {
      tabs.close(request.tabId);
      return undefined;
    },
  };
}
