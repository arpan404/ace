import { app, nativeImage, powerSaveBlocker, type BrowserWindow, type NativeImage } from "electron";
import type { DesktopSettings } from "../../shared/contract.ts";
import type { WorkSummary } from "../link/thread-watch.ts";

/**
 * Dock and taskbar state from the daemon's thread list: the needs-you badge, a bounce or
 * taskbar flash when something new needs you, the Windows overlay and progress indicator
 * while agents work, and the optional power-save blocker.
 */
export class Attention {
  private summary: WorkSummary = { needsYou: 0, working: 0 };
  private blocker: number | undefined;
  private overlay: NativeImage | undefined;
  private settings: () => DesktopSettings;
  private window: () => BrowserWindow | undefined;

  constructor(settings: () => DesktopSettings, window: () => BrowserWindow | undefined) {
    this.settings = settings;
    this.window = window;
  }

  update(next: WorkSummary): void {
    const previous = this.summary;
    this.summary = next;
    const settings = this.settings();
    const win = this.window();
    app.setBadgeCount(next.needsYou);
    if (next.needsYou > previous.needsYou && settings.attention && !win?.isFocused()) {
      if (process.platform === "darwin") app.dock?.bounce("informational");
      else win?.flashFrame(true);
    }
    if (process.platform === "win32" && win) {
      win.setOverlayIcon(
        next.needsYou ? (this.overlay ??= dot()) : null,
        next.needsYou ? `${next.needsYou} need you` : "",
      );
      win.setProgressBar(next.working ? 2 : -1, { mode: next.working ? "indeterminate" : "none" });
    }
    this.sleep(settings.preventSleep && next.working > 0);
  }

  current(): WorkSummary {
    return this.summary;
  }

  /** Re-apply after settings change (power save toggled). */
  refresh(): void {
    this.update(this.summary);
  }

  private sleep(block: boolean): void {
    if (block && this.blocker === undefined)
      this.blocker = powerSaveBlocker.start("prevent-app-suspension");
    else if (!block && this.blocker !== undefined) {
      powerSaveBlocker.stop(this.blocker);
      this.blocker = undefined;
    }
  }
}

/** A 16 px needs-you dot for the Windows taskbar overlay, drawn without an asset file. */
function dot(): NativeImage {
  const size = 16;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const inside = (x - 7.5) ** 2 + (y - 7.5) ** 2 <= 7 ** 2;
      // BGRA: the design's needs-you amber.
      pixels.set(inside ? [0x2e, 0xa6, 0xf5, 0xff] : [0, 0, 0, 0], (y * size + x) * 4);
    }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}
