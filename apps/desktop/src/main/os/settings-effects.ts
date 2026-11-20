import type { DesktopSettings } from "../../shared/contract.ts";
import { talkShortcutOf } from "../spade-talk.ts";

/** What a global shortcut does: the quick thread, or push to talk to the main Spade. */
export type GlobalAction = "new-thread" | "spade-talk";

/** The OS hooks desktop settings drive: Electron's in the app, fakes in tests. */
export interface SettingsOs {
  /** Absent where this build never owns a login item (development builds, Linux). */
  loginItem?: { enabled(): boolean; setEnabled(on: boolean): void };
  /** `register` is false, or throws, when another app holds the chord. */
  shortcuts: {
    register(accelerator: string, action: GlobalAction): boolean;
    unregister(accelerator: string): void;
  };
  warn(message: string): void;
  /** Where the push-to-talk default comes from; absent: no default chord. */
  platform?: NodeJS.Platform;
}

/**
 * Returns the function that makes the OS match saved settings: the login item, the quick-thread
 * shortcut and the push-to-talk shortcut. Each is touched only when it differs from what the OS
 * already has, so saving an unrelated setting never re-registers any.
 */
export function settingsEffects(os: SettingsOs): (next: DesktopSettings) => void {
  const held: Record<GlobalAction, string | null> = { "new-thread": null, "spade-talk": null };
  const follow = (action: GlobalAction, wanted: string | null) => {
    if (wanted === held[action]) return;
    const before = held[action];
    if (before) os.shortcuts.unregister(before);
    held[action] = null;
    if (!wanted) return;
    // One chord does one thing: the one registered first keeps it.
    const other: GlobalAction = action === "new-thread" ? "spade-talk" : "new-thread";
    if (held[other] === wanted) {
      os.warn(`Global shortcut ${wanted} already does something else`);
      return;
    }
    let failure = "already taken";
    try {
      if (os.shortcuts.register(wanted, action)) held[action] = wanted;
    } catch (error) {
      failure = String(error);
    }
    if (!held[action]) os.warn(`Global shortcut ${wanted} is not available: ${failure}`);
  };
  return (next) => {
    if (os.loginItem && os.loginItem.enabled() !== next.openAtLogin)
      os.loginItem.setEnabled(next.openAtLogin);
    follow("new-thread", next.globalShortcut);
    follow(
      "spade-talk",
      os.platform ? talkShortcutOf(next, os.platform) : (next.spadeTalkShortcut ?? null),
    );
  };
}
