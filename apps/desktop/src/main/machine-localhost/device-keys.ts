import { appChord, browserChord, pageChord, type KeyInput } from "../shortcuts.ts";

/*
 * What a key pressed in a device tab does (ADR 0194): the browser's shortcuts, as on the
 * thread's own tabs, and the app's, which keep working while the page has focus. Pure.
 */

export type DeviceTabKey =
  /** The tab's own: carried out on the page here. */
  | { kind: "zoomIn" | "zoomOut" | "zoomReset" | "print" | "devtools" }
  | { kind: "reload" | "back" | "forward" }
  /** Typing moves to the tab's address field, in the app page. */
  | { kind: "address" }
  /** One of the app's shortcuts: the app page handles it as if typed there. */
  | { kind: "app"; accelerator: string };

const pageKeys: Readonly<Record<string, DeviceTabKey>> = {
  "CmdOrCtrl+=": { kind: "zoomIn" },
  "CmdOrCtrl+-": { kind: "zoomOut" },
  "CmdOrCtrl+0": { kind: "zoomReset" },
  "CmdOrCtrl+P": { kind: "print" },
  "Alt+CmdOrCtrl+I": { kind: "devtools" },
};
const browserKeys: Readonly<Record<string, DeviceTabKey>> = {
  "CmdOrCtrl+L": { kind: "address" },
  "CmdOrCtrl+R": { kind: "reload" },
  "CmdOrCtrl+[": { kind: "back" },
  "CmdOrCtrl+]": { kind: "forward" },
};

/**
 * The key's meaning in a device tab, or undefined when the page keeps it. Find
 * (`CmdOrCtrl+F`) stays the page's: a device tab has no find bar, and many web apps bind it.
 */
export function deviceTabKey(input: KeyInput, platform: NodeJS.Platform): DeviceTabKey | undefined {
  const page = pageChord(input, platform);
  if (page) return pageKeys[page];
  const browser = browserChord(input, platform);
  if (browser) return browserKeys[browser];
  const app = appChord(input, platform);
  return app ? { kind: "app", accelerator: app } : undefined;
}

/** Chromium's zoom levels a device tab steps through: each is 1.2 × the last, so ±20%. */
export function zoomedLevel(level: number, key: "zoomIn" | "zoomOut" | "zoomReset"): number {
  if (key === "zoomReset") return 0;
  return Math.min(5, Math.max(-5, Math.round(level) + (key === "zoomIn" ? 1 : -1)));
}
