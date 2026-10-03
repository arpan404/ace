import { contextBridge, ipcRenderer } from "electron";
import { deepLinkRoute, AppInfo } from "../shared/contract.ts";
import { createBridge, type BridgeIpc } from "./bridge.ts";
import { attachPageHooks } from "./page-hooks.ts";

/** Sandboxed preload: no Node APIs reach the page, only the parsed `window.ace` bridge. */
const argument = process.argv.find((value) => value.startsWith("--ace-info="));
const info = AppInfo.parse(JSON.parse(argument?.slice("--ace-info=".length) ?? "null"));

const ipc: BridgeIpc = {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  on(channel, listener) {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.off(channel, handler);
    };
  },
};
const bridge = createBridge(ipc, info);
contextBridge.exposeInMainWorld("ace", bridge);
attachPageHooks(bridge, window, deepLinkRoute);
