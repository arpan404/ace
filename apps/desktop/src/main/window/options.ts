import type { BrowserWindowConstructorOptions } from "electron";
import { minimumSize, type Rectangle } from "./bounds.ts";

/**
 * The approved design is translucent: the rail and sidebar are glass over the desktop.
 * - macOS: sidebar vibrancy, hidden inset title bar, traffic lights over the top of the rail
 *   and the sidebar's top row (16 px from the top and left).
 * - Windows 11: Mica behind a hidden title bar with native caption buttons overlaid.
 * - Linux: solid, with the system frame.
 */
export function windowOptions(options: {
  platform: NodeJS.Platform;
  bounds: Rectangle;
  preload: string;
  /** JSON app info for the sandboxed preload, which cannot read it from Electron. */
  info: string;
  dark: boolean;
  reducedTransparency: boolean;
}): BrowserWindowConstructorOptions {
  const solid = solidBackground(options.dark);
  const translucent = !options.reducedTransparency;
  const base: BrowserWindowConstructorOptions = {
    ...options.bounds,
    minWidth: minimumSize.width,
    minHeight: minimumSize.height,
    show: false,
    title: "ace",
    backgroundColor: solid,
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
      additionalArguments: [`--ace-info=${options.info}`],
    },
  };
  if (options.platform === "darwin")
    return {
      ...base,
      titleBarStyle: "hiddenInset",
      // Centred on the 50 px header's midline (the lights are about 14 px tall).
      trafficLightPosition: { x: 16, y: 18 },
      ...(translucent
        ? { vibrancy: "sidebar", visualEffectState: "followWindow", backgroundColor: "#00000000" }
        : {}),
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
      ...(translucent ? { backgroundMaterial: "mica", backgroundColor: "#00000000" } : {}),
    };
  return base;
}

/** The window's colour before the page paints, when no material shows through. */
export function solidBackground(dark: boolean): string {
  return dark ? "#0a0a0a" : "#f6f6f7";
}

/** Windows: the colour of the caption buttons drawn over the page. */
export function titleBarSymbolColor(dark: boolean): string {
  return dark ? "#e8e8ea" : "#1d1d20";
}

/**
 * With vibrancy or Mica the page must let the material show through where the design puts
 * the wallpaper. Injected by the main process, so the web bundle stays platform-agnostic.
 */
export const translucentCss = `
html, body { background: transparent !important; }
:root { --wall: transparent; }
`;

/**
 * macOS: the traffic lights span x 16–68 at the top of the window, over the top of the rail and
 * the start of the sidebar's top row; both drag the window. Every first control starts at
 * x ≥ 80, 12 px clear of them: the rail's first view below them, the sidebar's title after them,
 * the header's first controls after them with the sidebar hidden (the full-view strip, the
 * right dock's `header-nav`, 4 px further in to make up its narrower padding), and on a narrow
 * window (rail and sidebar in a sheet) the header clears them from the window's edge. Full screen hides the lights, so
 * none of this applies there; the preload marks `<html data-fullscreen>`.
 */
export const macTitleBarCss = `
:root:not([data-fullscreen]) [data-slot="rail"] { padding-top: 44px; }
:root:not([data-fullscreen]) [data-slot="sidebar-top"] { padding-left: 40px; }
:root:not([data-fullscreen]) [data-sidebar="hidden"] [data-slot="header-nav"] { margin-left: 28px; }
:root:not([data-fullscreen]) [data-sidebar="hidden"] [data-dock="right"] [data-slot="header-nav"] { margin-left: 32px; }
:root:not([data-fullscreen]) [data-sidebar="sheet"] [data-slot="header-nav"] { margin-left: 68px; }
`;
