import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { z } from "zod";
import { DaemonNetwork } from "../../src/main/daemon-network.ts";
import { installDaemonNetwork, registerAppScheme, serveRenderer } from "../../src/main/renderer.ts";
import { requestChannel, requests } from "../../src/shared/channels.ts";

const environment = z
  .object({ ACE_E2E_USER_DATA: z.string(), ACE_E2E_ORIGINS: z.string() })
  .parse(process.env);
const directory = fileURLToPath(new URL(".", import.meta.url));
app.setPath("userData", environment.ACE_E2E_USER_DATA);
// The test servers use the repository's test-only self-signed certificate.
app.commandLine.appendSwitch("ignore-certificate-errors");
registerAppScheme();
await app.whenReady();
const network = new DaemonNetwork();
installDaemonNetwork(network);
const origin = await serveRenderer(directory, [], network);
const window = new BrowserWindow({
  webPreferences: {
    preload: join(directory, "preload.cjs"),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    additionalArguments: [
      `--ace-info=${JSON.stringify({
        version: "0.1.0",
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron,
        packaged: false,
      })}`,
    ],
  },
});
ipcMain.handle(requestChannel("daemon.authorize"), (event, payload: unknown) => {
  if (event.sender !== window.webContents) throw new Error("Unknown renderer");
  network.authorize(requests["daemon.authorize"].request.parse(payload));
});
await window.loadURL(`${origin}#${environment.ACE_E2E_ORIGINS}`);
