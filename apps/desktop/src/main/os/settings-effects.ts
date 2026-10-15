import type { DesktopSettings } from "../../shared/contract.ts";

/** The OS hooks desktop settings drive: Electron's in the app, fakes in tests. */
export interface SettingsOs {
  /** Absent where this build never owns a login item (development builds, Linux). */
  loginItem?: { enabled(): boolean; setEnabled(on: boolean): void };
  /** `register` is false, or throws, when another app holds the chord. */
  shortcuts: { register(accelerator: string): boolean; unregister(accelerator: string): void };
  warn(message: string): void;
}

/**
 * Returns the function that makes the OS match saved settings: the login item and the
 * quick-thread shortcut. Each is touched only when it differs from what the OS already has,
 * so saving an unrelated setting never re-registers either.
 */
export function settingsEffects(os: SettingsOs): (next: DesktopSettings) => void {
  let shortcut: string | null = null;
  return (next) => {
    if (os.loginItem && os.loginItem.enabled() !== next.openAtLogin)
      os.loginItem.setEnabled(next.openAtLogin);
    if (next.globalShortcut === shortcut) return;
    if (shortcut) os.shortcuts.unregister(shortcut);
    shortcut = null;
    if (!next.globalShortcut) return;
    let failure = "already taken";
    try {
      if (os.shortcuts.register(next.globalShortcut)) shortcut = next.globalShortcut;
    } catch (error) {
      failure = String(error);
    }
    if (!shortcut) os.warn(`Global shortcut ${next.globalShortcut} is not available: ${failure}`);
  };
}
