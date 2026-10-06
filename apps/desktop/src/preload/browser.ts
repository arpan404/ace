import { contextBridge, ipcRenderer } from "electron";
if (!process.sandboxed) throw new Error("Browser dialog preload requires the OS sandbox");
/** Remote frames get only dialog primitives, never the app's general IPC bridge. */
contextBridge.exposeInMainWorld(
  "__aceDialog",
  (type: unknown, message: unknown, defaultPrompt: unknown) => {
    if (
      !["alert", "confirm", "prompt"].includes(typeof type === "string" ? type : "") ||
      typeof message !== "string" ||
      typeof defaultPrompt !== "string"
    )
      return null;
    const value: unknown = ipcRenderer.sendSync("ace:browser.dialog", {
      type,
      message: message.slice(0, 4096),
      defaultPrompt: defaultPrompt.slice(0, 4096),
    });
    return typeof value === "string" || typeof value === "boolean" ? value : null;
  },
);

// Install in each frame's main world, including out-of-process cross-origin frames.
contextBridge.executeInMainWorld({
  func: () => {
    const dialog: unknown = Reflect.get(window, "__aceDialog");
    if (typeof dialog !== "function") throw new Error("Browser dialog bridge missing");
    window.alert = (message: unknown = "") => {
      dialog("alert", String(message), "");
    };
    window.confirm = (message: unknown = "") => dialog("confirm", String(message), "") === true;
    window.prompt = (message: unknown = "", defaultValue: unknown = "") => {
      const value: unknown = dialog("prompt", String(message), String(defaultValue));
      return typeof value === "string" ? value : null;
    };
  },
});
