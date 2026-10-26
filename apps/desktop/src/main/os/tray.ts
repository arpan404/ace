import { basename, dirname, join } from "node:path";
import { Menu, Tray, nativeImage, type NativeImage } from "electron";
import type { DaemonStatus } from "../../shared/contract.ts";
import type { WorkSummary } from "../link/thread-watch.ts";

export interface TrayActions {
  open(): void;
  pause(paused: boolean): void;
  quitAll(): void;
}

/**
 * The menu-bar (macOS) or notification-area icon while ace keeps running in the background:
 * daemon status, the needs-you count, Open, Pause new work, and Quit (which also stops a
 * daemon this app started).
 */
export class StatusTray {
  private tray: Tray | undefined;
  private status: DaemonStatus | undefined;
  private summary: WorkSummary = { needsYou: 0, working: 0, held: 0 };
  /** What the tray shows now; a status or summary update that changes none of it is skipped. */
  private shown: string | undefined;
  private actions: TrayActions;
  private iconPath: string;

  /** `iconPath` is the 1x template image; its `@2x` sibling is picked up beside it. */
  constructor(actions: TrayActions, iconPath: string) {
    this.actions = actions;
    this.iconPath = iconPath;
  }

  show(): void {
    if (this.tray) return;
    this.tray = new Tray(icon(this.iconPath));
    this.tray.setToolTip("ace");
    this.tray.on("click", () => {
      if (process.platform !== "darwin") this.actions.open();
    });
    this.render();
  }

  hide(): void {
    this.tray?.destroy();
    this.tray = undefined;
    this.shown = undefined;
  }

  update(patch: { status?: DaemonStatus; summary?: WorkSummary }): void {
    if (patch.status) this.status = patch.status;
    if (patch.summary) this.summary = patch.summary;
    this.render();
  }

  private render(): void {
    const tray = this.tray;
    if (!tray) return;
    const { needsYou, working } = this.summary;
    const paused = this.status?.paused ?? false;
    const state = this.status
      ? this.status.state === "running"
        ? paused
          ? "Paused: running work finishes, new work waits"
          : working
            ? `${working} working`
            : "Idle"
        : `Daemon ${this.status.state}`
      : "Starting…";
    const running = this.status?.state === "running";
    const shown = JSON.stringify([state, needsYou, paused, running]);
    if (shown === this.shown) return;
    this.shown = shown;
    if (process.platform === "darwin") tray.setTitle(needsYou ? ` ${needsYou}` : "");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: state, enabled: false },
        { label: needsYou ? `${needsYou} need you` : "Nothing needs you", enabled: false },
        { type: "separator" },
        { label: "Open ace", click: () => this.actions.open() },
        {
          label: paused ? "Resume new work" : "Pause new work",
          enabled: running,
          click: () => this.actions.pause(!paused),
        },
        { type: "separator" },
        { label: "Quit ace", click: () => this.actions.quitAll() },
      ]),
    );
  }
}

/**
 * The tray image: on macOS a template the menu bar tints; elsewhere the image as drawn (Linux
 * gets the colour app tile, see `appPaths().trayIcon`).
 */
function icon(path: string): NativeImage {
  if (process.platform === "win32") return windowsIcon(path);
  const image = nativeImage.createFromPath(path);
  if (image.isEmpty()) return fallbackIcon();
  if (process.platform === "darwin") image.setTemplateImage(true);
  return image;
}

/**
 * Windows: the colour app tile beside the template image (both are packaged). The taskbar never
 * tints tray icons and is dark by default, where the black template glyph would vanish.
 */
function windowsIcon(templatePath: string): NativeImage {
  const image = nativeImage.createFromPath(
    join(dirname(templatePath), basename(templatePath).replace("trayTemplate", "trayColor")),
  );
  // The notification area's slot is 16 px (more at higher scales, drawn from the 2x image).
  return image.isEmpty()
    ? fallbackIcon()
    : image.resize({ width: 16, height: 16, quality: "best" });
}

/** An 18 pt ring drawn at 2x, so a missing image file never leaves the tray without an icon. */
function fallbackIcon(): NativeImage {
  const size = 36;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - 17.5, y - 17.5);
      const alpha = distance <= 13 && distance >= 8.5 ? 0xff : 0;
      // A mid grey stays visible on light and dark panels that never tint the icon.
      const shade = process.platform === "darwin" ? 0 : 0x9a;
      pixels.set([shade, shade, shade, alpha], (y * size + x) * 4);
    }
  const image = nativeImage.createFromBitmap(pixels, {
    width: size,
    height: size,
    scaleFactor: 2,
  });
  if (process.platform === "darwin") image.setTemplateImage(true);
  return image;
}
