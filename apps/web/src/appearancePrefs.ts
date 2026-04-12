import { useCallback, useSyncExternalStore } from "react";

import { DEFAULT_THEME_PRESET, type ThemePresetId, parseThemePresetId } from "./themePresets";

const STORAGE_PRESET = "ace:theme-preset";

/** Legacy keys from the old color-theme + accent split — cleared once. */
const LEGACY_KEYS = ["ace:color-theme", "ace:accent"] as const;

let legacyKeysCleared = false;
let listeners: Array<() => void> = [];
let cachedSnapshot: ThemePresetId | null = null;

function emitChange() {
  cachedSnapshot = null;
  for (const listener of listeners) {
    listener();
  }
}

function migrateLegacyKeys() {
  if (legacyKeysCleared || typeof localStorage === "undefined") {
    return;
  }
  legacyKeysCleared = true;
  for (const key of LEGACY_KEYS) {
    localStorage.removeItem(key);
  }
}

export function readStoredThemePreset(): ThemePresetId {
  if (typeof window === "undefined") {
    return DEFAULT_THEME_PRESET;
  }
  migrateLegacyKeys();
  return parseThemePresetId(localStorage.getItem(STORAGE_PRESET));
}

function getSnapshot(): ThemePresetId {
  const next = readStoredThemePreset();
  if (cachedSnapshot === next) {
    return cachedSnapshot;
  }
  cachedSnapshot = next;
  return cachedSnapshot;
}

/** Sets `data-theme-preset` on the root element for all presets. */
export function applyThemePreset(preset: ThemePresetId) {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.setAttribute("data-theme-preset", preset);
}

export function persistThemePreset(preset: ThemePresetId) {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(STORAGE_PRESET, preset);
  applyThemePreset(preset);
  emitChange();
}

export function resetThemePresetToDefault() {
  persistThemePreset(DEFAULT_THEME_PRESET);
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);

  const handleStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_PRESET) {
      migrateLegacyKeys();
      applyThemePreset(readStoredThemePreset());
      emitChange();
    }
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    listeners = listeners.filter((l) => l !== listener);
    window.removeEventListener("storage", handleStorage);
  };
}

export function useAppearancePrefs() {
  const themePreset = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_THEME_PRESET);

  const setThemePreset = useCallback((preset: ThemePresetId) => {
    persistThemePreset(preset);
  }, []);

  return { themePreset, setThemePreset } as const;
}

if (typeof window !== "undefined") {
  migrateLegacyKeys();
  applyThemePreset(readStoredThemePreset());
}
