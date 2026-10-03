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
  private summary: WorkSummary = { needsYou: 0, working: 0 };
  /** What the tray shows now; a status or summary update that changes none of it is skipped. */
  private shown: string | undefined;
  private actions: TrayActions;

  constructor(actions: TrayActions) {
    this.actions = actions;
  }

  show(): void {
    if (this.tray) return;
    this.tray = new Tray(icon());
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

/** An 18 pt ring drawn at 2x, as a macOS template image (tinted by the menu bar). */
function icon(): NativeImage {
  const size = 36;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - 17.5, y - 17.5);
      const alpha = distance <= 13 && distance >= 8.5 ? 0xff : 0;
      pixels.set([0, 0, 0, alpha], (y * size + x) * 4);
    }
  const image = nativeImage.createFromBitmap(pixels, {
    width: size,
    height: size,
    scaleFactor: 2,
  });
  image.setTemplateImage(true);
  return image;
}
