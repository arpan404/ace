import { z } from "zod";

export const Theme = z.enum(["light", "dark", "system"]);
export type Theme = z.infer<typeof Theme>;
export const Density = z.enum(["comfortable", "compact"]);
export type Density = z.infer<typeof Density>;

/** Local, per-device UI preferences. Daemon settings live in the daemon, not here. */
export const Preferences = z.object({
  theme: Theme.catch("system"),
  density: Density.catch("comfortable"),
});
export type Preferences = z.infer<typeof Preferences>;
export const defaultPreferences: Preferences = { theme: "system", density: "comfortable" };

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const keys = { theme: "ace.theme", density: "ace.density" } as const;

/** Storage is outside the process boundary, so every read is parsed. */
export function loadPreferences(storage: KeyValueStorage | undefined): Preferences {
  if (!storage) return defaultPreferences;
  try {
    return Preferences.parse({
      theme: storage.getItem(keys.theme) ?? undefined,
      density: storage.getItem(keys.density) ?? undefined,
    });
  } catch {
    return defaultPreferences;
  }
}
export function savePreferences(storage: KeyValueStorage | undefined, value: Preferences): void {
  try {
    storage?.setItem(keys.theme, value.theme);
    storage?.setItem(keys.density, value.density);
  } catch {
    /* Private mode or quota: preferences stay in memory for this session. */
  }
}
