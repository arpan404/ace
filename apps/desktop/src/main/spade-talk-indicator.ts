import { BrowserWindow, screen } from "electron";
import type { SpadeTalkState } from "../shared/contract.ts";
import { talkCancelUrl, talkIndicatorPage, talkIndicatorWords } from "./spade-talk.ts";

/*
 * The small floating line push to talk shows while a turn lasts (ADR 0134, amended): above
 * every window, never taking focus from the app the person is in, at the foot of the screen
 * they are on. Words only; Cancel ends the turn. It holds no page of ace's and no bridge.
 */

const width = 320;
const height = 52;

export function talkIndicator(options: { cancel(): void }) {
  let window: BrowserWindow | undefined;
  let words: string | undefined;

  const show = (text: string) => {
    if (!window || window.isDestroyed()) {
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const created = new BrowserWindow({
        width,
        height,
        x: Math.round(area.x + (area.width - width) / 2),
        y: Math.round(area.y + area.height - height - 24),
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, javascript: true },
      });
      created.setAlwaysOnTop(true, "floating");
      created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      created.webContents.on("will-navigate", (event, url) => {
        event.preventDefault();
        if (url === talkCancelUrl) options.cancel();
      });
      created.webContents.once("did-finish-load", () => {
        void write(created, words ?? text);
        created.showInactive();
      });
      void created.loadURL(talkIndicatorPage());
      window = created;
    } else {
      void write(window, text);
      if (!window.isVisible()) window.showInactive();
    }
  };

  return {
    /** Shows the turn's state, or hides the indicator once it is over. */
    set(state: SpadeTalkState) {
      words = talkIndicatorWords(state);
      if (words) show(words);
      else if (window && !window.isDestroyed()) window.hide();
    },
    dispose() {
      if (window && !window.isDestroyed()) window.destroy();
      window = undefined;
    },
  };
}

/** Puts the words in the indicator's line; JSON-encoded, so they are only ever text. */
function write(window: BrowserWindow, text: string) {
  if (window.isDestroyed() || window.webContents.isLoading()) return Promise.resolve();
  return window.webContents
    .executeJavaScript(`document.getElementById("words").textContent = ${JSON.stringify(text)}`)
    .catch(() => {});
}
