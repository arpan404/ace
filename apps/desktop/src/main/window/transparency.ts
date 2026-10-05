import { solidBackground, translucentCss } from "./options.ts";

/** Whether the window shows the platform's material (vibrancy, Mica) behind the page. */
export function translucentWindow(
  platform: NodeJS.Platform,
  reducedTransparency: boolean,
): boolean {
  return !reducedTransparency && (platform === "darwin" || platform === "win32");
}

/** The window calls the material needs; a `BrowserWindow` in the app. */
export interface MaterialWindow {
  setVibrancy(type: "sidebar" | null): void;
  setBackgroundMaterial(material: "mica" | "none"): void;
  setBackgroundColor(color: string): void;
}

/** The page calls the see-through CSS needs; the window's `webContents` in the app. */
export interface StyledPage {
  insertCSS(css: string): Promise<string>;
  removeInsertedCSS(key: string): Promise<void>;
}

/**
 * Keeps the window's material and the page's see-through CSS in step with the system's
 * Reduce Transparency setting, which can change while ace runs: solid when it is on, glass
 * when it is off.
 */
export class WindowMaterial {
  private platform: NodeJS.Platform;
  private window: MaterialWindow;
  private page: StyledPage;
  private translucent: boolean;
  /** The key of the CSS inserted into the current document, while it is translucent. */
  private inserted: Promise<string> | undefined;

  constructor(options: {
    platform: NodeJS.Platform;
    window: MaterialWindow;
    page: StyledPage;
    /** As the window was created (`windowOptions`). */
    reducedTransparency: boolean;
  }) {
    this.platform = options.platform;
    this.window = options.window;
    this.page = options.page;
    this.translucent = translucentWindow(options.platform, options.reducedTransparency);
  }

  /** A new document loaded: its styles start empty, so a translucent window adds its CSS again. */
  pageLoaded(): void {
    this.inserted = this.translucent ? this.insert() : undefined;
  }

  /** The system setting may have changed: switch material and CSS if it did. */
  update(reducedTransparency: boolean, dark: boolean): void {
    const next = translucentWindow(this.platform, reducedTransparency);
    if (next === this.translucent) return;
    this.translucent = next;
    if (this.platform === "darwin") this.window.setVibrancy(next ? "sidebar" : null);
    if (this.platform === "win32") this.window.setBackgroundMaterial(next ? "mica" : "none");
    this.window.setBackgroundColor(next ? "#00000000" : solidBackground(dark));
    if (next) {
      this.inserted = this.insert();
      return;
    }
    const inserted = this.inserted;
    this.inserted = undefined;
    void inserted
      ?.then((key) => this.page.removeInsertedCSS(key))
      // The document it went into may be gone already, and its styles with it.
      .catch(() => {});
  }

  private insert(): Promise<string> {
    const inserted = this.page.insertCSS(translucentCss);
    inserted.catch(() => {});
    return inserted;
  }
}
