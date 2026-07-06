import { DEFAULT_THEME_PRESET, type ThemePresetId, parseThemePresetId } from "./themePresets";

const STORAGE_PRESET = "ace:theme-preset";

/** Legacy keys from the old color-theme + accent split — cleared once. */
const LEGACY_KEYS = ["ace:color-theme", "ace:accent"] as const;

let legacyKeysCleared = false;

function migrateLegacyKeys() {
  if (legacyKeysCleared || typeof localStorage === "undefined") {
    return;
  }
  legacyKeysCleared = true;
  for (const key of LEGACY_KEYS) {
    localStorage.removeItem(key);
  }
}

function readStoredThemePreset(): ThemePresetId {
  if (typeof window === "undefined") {
    return DEFAULT_THEME_PRESET;
  }
  migrateLegacyKeys();
  return parseThemePresetId(localStorage.getItem(STORAGE_PRESET));
}

/** Sets `data-theme-preset` on the root element for all presets. */
function applyThemePreset(preset: ThemePresetId) {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.setAttribute("data-theme-preset", preset);
}

let listeners: Array<() => void> = [];

function emitChange() {
  for (const listener of listeners) listener();
}

function persistThemePreset(preset: ThemePresetId) {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(STORAGE_PRESET, preset);
  applyThemePreset(preset);
  emitChange();
}

/** Set and persist the active color preset. */
export function setStoredThemePreset(preset: ThemePresetId) {
  persistThemePreset(preset);
}

/** Subscribe to preset changes (this tab and cross-tab). */
export function subscribeThemePreset(listener: () => void): () => void {
  listeners.push(listener);

  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_PRESET) {
      applyThemePreset(readStoredThemePreset());
      emitChange();
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", handleStorage);
  }

  return () => {
    listeners = listeners.filter((l) => l !== listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorage);
    }
  };
}

export function resetThemePresetToDefault() {
  persistThemePreset(DEFAULT_THEME_PRESET);
}

if (typeof window !== "undefined") {
  migrateLegacyKeys();
  applyThemePreset(readStoredThemePreset());
}
