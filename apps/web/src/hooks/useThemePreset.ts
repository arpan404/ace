import { useSyncExternalStore } from "react";

import { setStoredThemePreset, subscribeThemePreset } from "../appearancePrefs";
import { DEFAULT_THEME_PRESET, parseThemePresetId, type ThemePresetId } from "../themePresets";

const STORAGE_PRESET = "ace:theme-preset";

function getSnapshot(): ThemePresetId {
  if (typeof localStorage === "undefined") {
    return DEFAULT_THEME_PRESET;
  }
  return parseThemePresetId(localStorage.getItem(STORAGE_PRESET));
}

function getServerSnapshot(): ThemePresetId {
  return DEFAULT_THEME_PRESET;
}

export function useThemePreset() {
  const preset = useSyncExternalStore(subscribeThemePreset, getSnapshot, getServerSnapshot);
  return { preset, setPreset: setStoredThemePreset } as const;
}
