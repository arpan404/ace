import { BrowserWindow, type WebContents } from "electron";
import { NativeBasicAuth } from "./basic-auth.ts";
import { NativeDialogs } from "./dialogs.ts";
import { WebSocketGate } from "./socket-gate.ts";

/** Human-requested auth windows retain their opener and the thread's isolated session. */
export class NativePopups {
  private window: BrowserWindow | undefined;
  private dialogs: NativeDialogs | undefined;
  private auth: NativeBasicAuth | undefined;
  private gate = new WebSocketGate(new Set(["http:", "https:", "ws:", "wss:"]), "popup-");
  constructor(privatePorts: {
    contents: WebContents;
    authPreload?: string | undefined;
    allowed(): boolean;
    emit(method: string, params: unknown): void;
    remember(contents: WebContents): () => void;
    navigate(url: string): void;
  }) {
    this.ports = privatePorts;
    const { contents } = privatePorts;
    contents.setWindowOpenHandler((details) => {
      const auth =
        details.features !== "" ||
        (details.frameName !== "" && !details.frameName.startsWith("_")) ||
        details.disposition === "new-window" ||
        details.disposition === "default";
      if (!auth || !privatePorts.allowed() || this.window) {
        privatePorts.navigate(details.url);
        return { action: "deny" };
      }
      return {
        action: "allow",
        createWindow: (options) => {
          const popup = new BrowserWindow({
            ...options,
            show: false,
            width: 600,
            height: 720,
            webPreferences: {
              ...options.webPreferences,
              session: contents.session,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              webviewTag: false,
            },
          });
          this.window = popup;
          const forget = privatePorts.remember(popup.webContents);
          this.dialogs = new NativeDialogs(popup.webContents, privatePorts.emit);
          this.auth = new NativeBasicAuth(
            popup.webContents,
            privatePorts.allowed,
            privatePorts.authPreload,
          );
          popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
          popup.once("ready-to-show", () => {
            if (privatePorts.allowed() && !popup.isDestroyed()) popup.showInactive();
          });
          popup.once("closed", () => {
            forget();
            this.auth?.close();
            this.auth = undefined;
            this.window = undefined;
            this.dialogs = undefined;
          });
          return popup.webContents;
        },
      };
    });
  }
  private ports: {
    contents: WebContents;
    authPreload?: string | undefined;
    allowed(): boolean;
    emit(method: string, params: unknown): void;
    remember(contents: WebContents): () => void;
    navigate(url: string): void;
  };
  request(url: string, reply: (allowed: boolean) => void): void {
    this.gate.request(url, this.ports.emit, reply);
  }
  command(method: string, params: unknown): boolean {
    this.gate.command(method, params);
    return this.dialogs?.answer(method, params) ?? false;
  }
  close(): void {
    this.gate.close();
    this.dialogs?.close();
    this.auth?.close();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
  }
}
