/** The part of Electron's `app.commandLine` that enables Chromium features. */
export interface FeatureSwitches {
  getSwitchValue(name: string): string;
  appendSwitch(name: string, value: string): void;
}

/**
 * Adds Chromium features to `--enable-features`. Chromium reads only the last value of a
 * repeated switch, so the features already enabled (by the person's own flags or by other
 * modules) are kept in the one value written here. Call before the app is ready.
 */
export function enableFeatures(switches: FeatureSwitches, features: readonly string[]): void {
  const current = switches
    .getSwitchValue("enable-features")
    .split(",")
    .map((feature) => feature.trim())
    .filter(Boolean);
  const missing = features.filter((feature) => !current.includes(feature));
  if (!missing.length) return;
  switches.appendSwitch("enable-features", [...current, ...missing].join(","));
}

/**
 * Linux's Chromium features: on Wayland a global shortcut can only be grabbed through the XDG
 * GlobalShortcuts portal, which Chromium uses only with `GlobalShortcutsPortal` on, and on
 * GNOME only with `GlobalShortcutsPortalPreferredTrigger` as well (it hands GNOME the keys to
 * offer in its consent dialog). X11 grabs keys directly and is unaffected.
 */
export function linuxFeatures(platform: NodeJS.Platform): readonly string[] {
  return platform === "linux"
    ? ["GlobalShortcutsPortal", "GlobalShortcutsPortalPreferredTrigger"]
    : [];
}
