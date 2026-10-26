/** The parts of a hidden `BrowserWindow` that decide when it shows. */
export interface HiddenWindow {
  once(event: "ready-to-show" | "closed", listener: () => void): unknown;
  isDestroyed(): boolean;
  webContents: { once(event: "did-finish-load", listener: () => void): unknown };
}

export interface ShowTimers {
  /** Calls back after `delayMs`; returns a cancel function. */
  set(delayMs: number, callback: () => void): () => void;
}

/**
 * How long a Linux window waits after its page loads for Chromium to say it has painted. On
 * Wayland a window that was never mapped gets no frames, so a page whose first paint comes
 * after it loads never reports `ready-to-show`; the window would stay hidden for good.
 */
export const linuxShowGraceMs = 1_000;

/**
 * Shows a window created hidden once its page has painted (`ready-to-show`), so it never opens
 * blank. With `graceMs` (Linux), it also shows once its page has loaded and that long has
 * passed without a paint report: blank for a moment beats never appearing. `show` runs once,
 * and never after the window is closed.
 */
export function showWhenReady(
  window: HiddenWindow,
  show: () => void,
  options: { timers: ShowTimers; graceMs: number | undefined },
): void {
  let shown = false;
  let cancel: (() => void) | undefined;
  const reveal = () => {
    cancel?.();
    cancel = undefined;
    if (shown || window.isDestroyed()) return;
    shown = true;
    show();
  };
  window.once("ready-to-show", reveal);
  window.once("closed", () => {
    cancel?.();
    shown = true;
  });
  const grace = options.graceMs;
  if (grace === undefined) return;
  window.webContents.once("did-finish-load", () => {
    if (!shown) cancel = options.timers.set(grace, reveal);
  });
}
