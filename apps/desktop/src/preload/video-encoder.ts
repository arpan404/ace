import { contextBridge, ipcRenderer } from "electron";

/*
 * Only for the desktop's hidden video encoder page (`main/browser/video-encoder.ts`), never a
 * web page or the app renderer. The encoder (`@ace/browser/video-encoder`) reports each event
 * here, with a chunk's bytes as they are; the main process checks what it receives.
 */
contextBridge.exposeInMainWorld("aceVideoEmit", (event: unknown, bytes?: unknown) => {
  ipcRenderer.send("ace:video.event", event, bytes instanceof Uint8Array ? bytes : undefined);
});
