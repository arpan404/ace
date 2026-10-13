import type { BrowserWindowConstructorOptions } from "electron";
import { minimumSize, type Rectangle } from "./bounds.ts";

/**
 * The page paints the whole window: the sidebar and reading column are opaque and only floating
 * layers are glass (docs/design/visual-language.md), so no platform material sits behind it.
 * - macOS: hidden inset title bar, traffic lights over the top of the sidebar and the sidebar's
 *   top row (16 px from the top and left).
 * - Windows 11: hidden title bar with native caption buttons overlaid.
 * - Linux: the system frame.
 */
export function windowOptions(options: {
  platform: NodeJS.Platform;
  bounds: Rectangle;
  preload: string;
  /** JSON app info for the sandboxed preload, which cannot read it from Electron. */
  info: string;
  dark: boolean;
  /** The page's own theme colour, once it has told the app (`windowBackground`). */
  background?: string | undefined;
}): BrowserWindowConstructorOptions {
  const base: BrowserWindowConstructorOptions = {
    ...options.bounds,
    minWidth: minimumSize.width,
    minHeight: minimumSize.height,
    show: false,
    title: "ace",
    backgroundColor: options.background ?? solidBackground(options.dark),
    webPreferences: {
      preload: options.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      // A hidden or minimised window runs timers at background rate and draws no frames; the
      // client worker sends a hidden page nothing until it is shown (ADR 0056).
      backgroundThrottling: true,
      spellcheck: true,
      // Chromium's built-in PDF viewer, for attachment previews; no third-party plugins exist.
      plugins: true,
      additionalArguments: [`--ace-info=${options.info}`],
    },
  };
  if (options.platform === "darwin")
    return {
      ...base,
      titleBarStyle: "hiddenInset",
      // Centred on the 50 px header's midline (the lights are about 14 px tall).
      trafficLightPosition: { x: 16, y: 18 },
    };
  if (options.platform === "win32")
    return {
      ...base,
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#00000000",
        symbolColor: titleBarSymbolColor(options.dark),
        height: 50,
      },
    };
  return base;
}

/** The window's colour before the page paints: the default theme's (Graphite) page colour. */
export function solidBackground(dark: boolean): string {
  return dark ? "#161616" : "#fdfdfd";
}

/** Windows: the colour of the caption buttons drawn over the page. */
export function titleBarSymbolColor(dark: boolean): string {
  return dark ? "#e8e8ea" : "#1d1d20";
}

/**
 * macOS: the traffic lights span x 16–68 at the top of the window, over the start of the sidebar's
 * top row, which drags the window. Every first control starts at x ≥ 80, 12 px clear of them: the
 * sidebar's wordmark after them, the header's back, forward and sidebar toggle (`header-nav`)
 * after them with the sidebar hidden (the full-view strip, the side panel's `header-nav`, 4 px
 * further in to make up its narrower padding), and on a narrow window (the sidebar in a sheet)
 * the header clears them from the window's edge. With the sidebar shown, the header starts past
 * it and needs no room.
 * Full screen hides the lights, so none of this applies there; the preload marks
 * `<html data-fullscreen>`.
 */
export const macTitleBarCss = `
:root:not([data-fullscreen]) [data-slot="sidebar-top"] { padding-left: 80px; }
:root:not([data-fullscreen]) [data-sidebar="hidden"] [data-slot="header-nav"] { margin-left: 68px; }
:root:not([data-fullscreen]) [data-sidebar="hidden"] [data-panel] [data-slot="header-nav"] { margin-left: 72px; }
:root:not([data-fullscreen]) [data-sidebar="sheet"] [data-slot="header-nav"] { margin-left: 68px; }
`;
