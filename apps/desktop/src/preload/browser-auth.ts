import { contextBridge, ipcRenderer } from "electron";

/** Used only by the local HTTP-auth form, never a remote page or the app renderer. */
contextBridge.exposeInMainWorld("aceAuth", {
  submit(username: unknown, password: unknown) {
    if (typeof username !== "string" || typeof password !== "string") return;
    ipcRenderer.send("ace:browser.auth", { username, password });
  },
  cancel() {
    ipcRenderer.send("ace:browser.auth", null);
  },
});
