import { BrowserWindow, type WebContents } from "electron";
import { z } from "zod";

const Answer = z.object({ username: z.string().max(4096), password: z.string().max(4096) });
const form = `<!doctype html><meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<title>Sign in to this site</title><style>body{font:14px system-ui;margin:20px}label{display:block;margin:12px 0}input{display:block;width:95%;padding:6px}button{margin-right:12px}</style>
<h3>Sign in to this site</h3><form><label>Username<input name="username" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="current-password"></label><button>Sign in</button><button type="button" id="cancel">Cancel</button></form>
<script>document.querySelector('form').onsubmit=e=>{e.preventDefault();aceAuth.submit(e.target.username.value,e.target.password.value)};document.querySelector('#cancel').onclick=()=>aceAuth.cancel()</script>`;

/** Site credentials go directly to Electron's auth cache, never to the daemon or agent logs. */
export class NativeBasicAuth {
  private prompt: BrowserWindow | undefined;
  constructor(contents: WebContents, allowed: () => boolean, preload: string | undefined) {
    contents.on("login", (event, _details, _info, callback) => {
      event.preventDefault();
      if (!allowed() || !preload || this.prompt) {
        callback();
        return;
      }
      const prompt = new BrowserWindow({
        show: false,
        width: 400,
        height: 300,
        resizable: false,
        webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      this.prompt = prompt;
      let answered = false;
      const finish = (raw: unknown) => {
        if (answered) return;
        answered = true;
        const answer = Answer.safeParse(raw);
        if (allowed() && answer.success) callback(answer.data.username, answer.data.password);
        else callback();
        if (!prompt.isDestroyed()) prompt.destroy();
      };
      prompt.webContents.ipc.on("ace:browser.auth", (_event, raw: unknown) => finish(raw));
      prompt.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      prompt.webContents.on("will-navigate", (navigation) => navigation.preventDefault());
      prompt.once("closed", () => {
        this.prompt = undefined;
        finish(null);
      });
      void prompt
        .loadURL(`data:text/html,${encodeURIComponent(form)}`)
        .then(() => {
          if (allowed() && !prompt.isDestroyed()) prompt.showInactive();
          else finish(null);
        })
        .catch(() => finish(null));
    });
  }
  close(): void {
    if (this.prompt && !this.prompt.isDestroyed()) this.prompt.destroy();
  }
}
