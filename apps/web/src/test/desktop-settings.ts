import { vi } from "vitest";

interface Stored {
  background: boolean;
  openAtLogin: boolean;
  preventSleep: boolean;
  attention: boolean;
  globalShortcut: string | null;
  keybindings: Record<string, string> | null;
  notifications: {
    enabled: boolean;
    categories: Record<string, boolean>;
    quietHours: { start: number; end: number } | null;
  };
}

/**
 * The desktop app's settings bridge (`window.ace.settings`) as the page sees it: `update`
 * replaces whole top-level fields (`keybindingsIfUnset` only when none are stored), stores
 * them and announces the result, as the main process does. `refuse(true)` makes saves fail, as
 * a full disk would. Undo with `vi.unstubAllGlobals()`.
 */
export function fakeDesktopSettings() {
  let stored: Stored = {
    background: true,
    openAtLogin: false,
    preventSleep: false,
    attention: true,
    globalShortcut: null,
    keybindings: null,
    notifications: { enabled: true, categories: {}, quietHours: null },
  };
  let refusing = false;
  const listeners = new Set<(value: Stored) => void>();
  vi.stubGlobal("ace", {
    settings: {
      get: async () => stored,
      update: async ({
        keybindingsIfUnset,
        ...patch
      }: Partial<Stored> & { keybindingsIfUnset?: Record<string, string> }) => {
        if (refusing) throw new Error("Couldn't save");
        const adopted = keybindingsIfUnset && stored.keybindings === null;
        stored = { ...stored, ...(adopted ? { keybindings: keybindingsIfUnset } : {}), ...patch };
        for (const listener of listeners) listener(stored);
        return stored;
      },
      onChange: (listener: (value: Stored) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  return {
    stored: () => stored,
    refuse: (on: boolean) => {
      refusing = on;
    },
  };
}
