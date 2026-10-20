import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { BrowserBackend } from "../../src/main/browser/backend.ts";
import { BackendConnection } from "../../src/main/browser/connection.ts";
import { readDesktopCredential } from "../../src/main/browser/credential.ts";
import { VideoEncoderHost } from "../../src/main/browser/video-encoder.ts";
import { EmbeddedViews } from "../../src/main/browser/views.ts";
import { registerAppScheme } from "../../src/main/renderer.ts";

/*
 * An Electron main for `browser-video.e2e.ts`: the app's real embedded views, browser backend,
 * backend connection and video encoder, registered with the test's daemon socket as the
 * desktop app registers with its daemon. Nothing places the views: the page the daemon opens
 * stays unseen, as for a remote viewer while the app window shows something else.
 * `globalThis.harness.start` is called from the test through Playwright's `app.evaluate`.
 */

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

registerAppScheme();
app.setPath("userData", env("ACE_E2E_USER_DATA"));
void app.whenReady();
// Started by the test once Playwright holds the app (`app.evaluate`), as the other fixtures do.
Object.assign(globalThis, { harness: { start } });

function start(): void {
  const window = new BrowserWindow({ width: 1400, height: 900, show: true });
  void window.loadURL("about:blank");
  const log = (message: string) => console.log(`[desktop] ${message}`);
  const video = new VideoEncoderHost({ preload: env("ACE_E2E_VIDEO_PRELOAD"), log });
  const views = new EmbeddedViews({
    window: () => (window.isDestroyed() ? undefined : window),
    partitionsDir: join(app.getPath("userData"), "Partitions"),
    platform: process.platform,
    log,
    video,
  });
  const backend = new BrowserBackend(views, { log, video });
  const connection = new BackendConnection(
    backend,
    {
      daemon: async () => ({ url: env("ACE_E2E_DAEMON_URL"), token: env("ACE_E2E_TOKEN") }),
      credential: () => readDesktopCredential(env("ACE_E2E_HOME")),
      socket: (url) => new WebSocket(url),
      timers: {
        set(delayMs, callback) {
          const timer = setTimeout(callback, delayMs);
          return () => clearTimeout(timer);
        },
      },
      id: randomUUID,
      log,
    },
    { video: true },
  );
  connection.onState((state) => log(`backend ${state}`));
  // Held for the app's lifetime: a collected window would close, and quit the app.
  Object.assign(globalThis, { desktop: { window, video, views, backend, connection } });
  connection.setAvailable(true);
  app.on("before-quit", () => {
    video.close();
    void connection.close();
  });
}
