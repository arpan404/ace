import { contextBridge, ipcRenderer } from "electron";

/*
 * Only for the desktop's hidden video encoder page (`main/browser/video-encoder.ts`), never a
 * web page or the app renderer. The encoder (`@ace/browser/video-encoder`) reports each event
 * here; the main process checks what it receives.
 */
contextBridge.exposeInMainWorld("aceVideoEmit", (event: unknown) => {
  ipcRenderer.send("ace:video.event", event);
});
