import { BrowserWindow, screen, shell, type Rectangle, type WebContents } from "electron";
import { isExternalUrl } from "../csp.ts";
import { popoverBounds, popoverWidth, reopensOnClick } from "./tray-popover-place.ts";

export interface TrayPopoverOptions {
  /** The app's page; the popover loads its `/tray` route. */
  rendererUrl: string;
  preload: string;
  /** `AppInfo` as JSON, as the app window gets it. */
  info: string;
  now(): number;
}

/** The height the popover opens at before its page has measured itself. */
const firstHeight = 420;

/**
 * The menu-bar popover (macOS): a small panel under ace's icon showing what needs the person,
 * which apps agents are using, and usage, drawn by the web app's `/tray` route. It loads once,
 * ahead of the first click, and hides when it loses focus. The page sizes it (`tray.fit`).
 */
export class TrayPopover {
  private window: BrowserWindow | undefined;
  private anchor: Rectangle | undefined;
  private height = firstHeight;
  private hiddenAt: number | undefined;
  private options: TrayPopoverOptions;

  constructor(options: TrayPopoverOptions) {
    this.options = options;
  }

  /** Whether `contents` is the popover's page. */
  owns(contents: WebContents | undefined): boolean {
    const window = this.window;
    return Boolean(contents && window && !window.isDestroyed() && window.webContents === contents);
  }

  /** Load the page now, so the first click opens it with its data. */
  prepare(): void {
    this.ensure();
  }

  /** The icon was clicked: open under it, or close if open. */
  toggle(anchor: Rectangle): void {
    const window = this.ensure();
    if (window.isVisible()) return this.hide();
    if (!reopensOnClick(this.hiddenAt, this.options.now())) return;
    this.anchor = anchor;
    this.place();
    window.show();
    window.focus();
  }

  hide(): void {
    const window = this.window;
    if (!window || window.isDestroyed() || !window.isVisible()) return;
    this.hiddenAt = this.options.now();
    window.hide();
  }

  /** The page's own height; it moves the popover only while it shows. */
  fit(height: number): void {
    this.height = height;
    if (this.window?.isVisible()) this.place();
  }

  destroy(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = undefined;
  }

  private place(): void {
    const window = this.window;
    const anchor = this.anchor;
    if (!window || window.isDestroyed() || !anchor) return;
    const area = screen.getDisplayMatching(anchor).workArea;
    window.setBounds(popoverBounds(anchor, area, this.height));
  }

  private ensure(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const mac = process.platform === "darwin";
    const window = new BrowserWindow({
      width: popoverWidth,
      height: firstHeight,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      roundedCorners: true,
      // The system's own popover material behind the page; the page lays the theme's glass
      // tint over it (solid where the person or the OS turned transparency down).
      ...(mac ? { type: "panel", vibrancy: "popover", visualEffectState: "active" } : {}),
      backgroundColor: "#00000000",
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
        additionalArguments: [`--ace-info=${this.options.info}`],
      },
    });
    if (mac) window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.setAlwaysOnTop(true, "pop-up-menu");
    window.on("blur", () => this.hide());
    const contents = window.webContents;
    const url = new URL("tray", this.options.rendererUrl).toString();
    // The popover stays on its one page; links to other sites open in the browser.
    contents.setWindowOpenHandler(({ url: target }) => {
      if (isExternalUrl(target)) void shell.openExternal(target).catch(() => {});
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, target) => {
      if (target !== url) event.preventDefault();
    });
    contents.on("render-process-gone", () => this.destroy());
    window.once("closed", () => {
      if (this.window === window) this.window = undefined;
    });
    void window.loadURL(url).catch(() => {});
    this.window = window;
    return window;
  }
}
