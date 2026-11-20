import { Menu, Tray, nativeImage, type NativeImage, type Rectangle } from "electron";
import type { DaemonStatus } from "../../shared/contract.ts";
import { noWork, type WorkSummary } from "../link/thread-watch.ts";
import { withAgentPointer } from "./tray-glyph.ts";

export interface TrayActions {
  open(): void;
  pause(paused: boolean): void;
  quitAll(): void;
  /** Quits and stops the daemon too. */
  quitCompletely(): void;
  /**
   * macOS: the icon was clicked; opens or closes the menu-bar popover under it. False when
   * there is no popover yet, and the menu opens instead.
   */
  popover?(icon: Rectangle): boolean;
}

/**
 * The menu-bar (macOS) or notification-area icon while ace keeps running in the background:
 * daemon status, the needs-you count, Open, Pause new work, Quit (the daemon this app started
 * keeps running, ADR 0186) and Quit ace completely (it stops too). On macOS a click opens the
 * popover (os/tray-popover.ts) and a right-click this menu, and while an agent uses an app the
 * agent's pointer shows beside the icon.
 */
export class StatusTray {
  private tray: Tray | undefined;
  private status: DaemonStatus | undefined;
  private summary: WorkSummary = noWork;
  /** What the tray shows now; a status or summary update that changes none of it is skipped. */
  private shown: string | undefined;
  private actions: TrayActions;
  private iconPath: string;
  private menu: Menu | undefined;
  /** An agent is using an app on this computer (the daemon's `computer.using`). */
  private usingApps = false;
  private images: { plain?: NativeImage; pointer?: NativeImage } = {};

  /** `iconPath` is the 1x template image; its `@2x` sibling is picked up beside it. */
  constructor(actions: TrayActions, iconPath: string) {
    this.actions = actions;
    this.iconPath = iconPath;
  }

  show(): void {
    if (this.tray) return;
    this.tray = new Tray(this.image());
    const tray = this.tray;
    tray.on("click", (_event, bounds) => {
      if (process.platform !== "darwin") return this.actions.open();
      if (this.actions.popover?.(bounds)) return;
      if (this.menu) tray.popUpContextMenu(this.menu);
    });
    tray.on("right-click", () => {
      if (this.menu && this.actions.popover) tray.popUpContextMenu(this.menu);
    });
    this.render();
  }

  hide(): void {
    this.tray?.destroy();
    this.tray = undefined;
    this.shown = undefined;
  }

  update(patch: { status?: DaemonStatus; summary?: WorkSummary; usingApps?: boolean }): void {
    if (patch.status) this.status = patch.status;
    if (patch.summary) this.summary = patch.summary;
    if (patch.usingApps !== undefined) this.usingApps = patch.usingApps;
    this.render();
  }

  /** The icon, with the agent's pointer beside it while an agent uses an app (macOS). */
  private image(): NativeImage {
    const plain = (this.images.plain ??= icon(this.iconPath));
    if (!this.usingApps || process.platform !== "darwin") return plain;
    return (this.images.pointer ??= agentPointerIcon(plain));
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
    // A running daemon carries a message only when it runs without something (safe mode).
    const note = running ? this.status?.message : undefined;
    const usingApps = this.usingApps;
    const shown = JSON.stringify([state, needsYou, paused, running, note, usingApps]);
    if (shown === this.shown) return;
    this.shown = shown;
    tray.setImage(this.image());
    tray.setToolTip(usingApps ? "ace: an agent is using an app" : "ace");
    if (process.platform === "darwin") tray.setTitle(needsYou ? ` ${needsYou}` : "");
    this.menu = Menu.buildFromTemplate([
      { label: state, enabled: false },
      ...(note ? [{ label: note, enabled: false }] : []),
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
      { label: "Quit ace completely", click: () => this.actions.quitCompletely() },
    ]);
    // With a popover, macOS opens the menu itself on a right-click (above); a menu set here
    // would open on every click instead.
    if (!this.actions.popover) tray.setContextMenu(this.menu);
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
 * The menu-bar template with ace's agent pointer drawn beside it (`withAgentPointer`), from its
 * sharpest representation; the icon as it is if its pixels can't be read.
 */
function agentPointerIcon(image: NativeImage): NativeImage {
  const scaleFactor = Math.max(1, ...image.getScaleFactors());
  const size = image.getSize();
  const width = Math.round(size.width * scaleFactor);
  const height = Math.round(size.height * scaleFactor);
  const data = image.toBitmap({ scaleFactor });
  if (data.length !== width * height * 4) return image;
  const drawn = withAgentPointer({ width, height, data });
  const composed = nativeImage.createFromBitmap(drawn.data, {
    width: drawn.width,
    height: drawn.height,
    scaleFactor,
  });
  composed.setTemplateImage(true);
  return composed;
}

/** Windows: the colour app tile (`appPaths().trayIcon`) at the notification area's size. */
function windowsIcon(path: string): NativeImage {
  const image = nativeImage.createFromPath(path);
  // The slot is 16 px (more at higher scales, drawn from the 2x image).
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
