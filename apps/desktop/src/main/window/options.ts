import type { BrowserWindowConstructorOptions } from "electron";
import { minimumSize, type Rectangle } from "./bounds.ts";

/**
 * The approved design is translucent: the sidebar is glass over the desktop.
 * - macOS: sidebar vibrancy, hidden inset title bar, traffic lights over the sidebar's top row
 *   (16 px from the top and left).
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
  const solid = options.dark ? "#0a0a0a" : "#f6f6f7";
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
      trafficLightPosition: { x: 16, y: 16 },
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
        symbolColor: options.dark ? "#e8e8ea" : "#1d1d20",
        height: 50,
      },
      ...(translucent ? { backgroundMaterial: "mica", backgroundColor: "#00000000" } : {}),
    };
  return base;
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
 * macOS: the traffic lights sit at (16, 16) over the sidebar's top row, which drags the window.
 * Full width, the row's wordmark starts after them; as a 68 px column of icons, they take the
 * row. With no sidebar beside it (hidden, or a sheet on a narrow window), the header's first
 * controls start after them; the sheet's own top row does the same.
 */
export const macTitleBarCss = `
[data-sidebar="expanded"] [data-slot="sidebar-top"],
[data-slot="sheet-content"] [data-slot="sidebar-top"] { padding-left: 80px; }
[data-sidebar="collapsed"] [data-slot="sidebar-wordmark"] { visibility: hidden; }
[data-sidebar="hidden"] [data-slot="header-nav"] { margin-left: 68px; }
`;
