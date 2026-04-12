import type { ClientSettings } from "@ace/contracts/settings";
import {
  DEFAULT_UI_FONT_FAMILY,
  DEFAULT_UI_FONT_SIZE_SCALE,
  DEFAULT_UI_LETTER_SPACING,
  DEFAULT_UI_MONO_FONT_FAMILY,
  type UiFontFamily,
  type UiFontSizeScale,
  type UiLetterSpacing,
  type UiMonoFontFamily,
} from "@ace/contracts/settings";

const UI_FONT_STACKS: Record<UiFontFamily, string> = {
  "plus-jakarta": `"Plus Jakarta Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`,
  inter: `"Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`,
  "system-ui": `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`,
  "dm-sans": `"DM Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`,
  "source-sans-3": `"Source Sans 3", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`,
};

const MONO_FONT_STACKS: Record<UiMonoFontFamily, string> = {
  jetbrains: `"JetBrainsMono Nerd Font", "JetBrainsMono Nerd Font Mono", "JetBrains Mono", "SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace`,
  "fira-code": `"Fira Code", "JetBrains Mono", "SF Mono", Consolas, "Liberation Mono", monospace`,
  "ibm-plex-mono": `"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace`,
  "system-mono": `ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace`,
};

const FONT_SIZE_BY_SCALE: Record<UiFontSizeScale, string> = {
  compact: "14px",
  normal: "15px",
  comfortable: "16px",
};

const LETTER_SPACING_BY_PRESET: Record<UiLetterSpacing, string> = {
  tight: "-0.025em",
  normal: "-0.018em",
  relaxed: "-0.012em",
};

export type UiTypographySettingsSlice = Pick<
  ClientSettings,
  "uiFontFamily" | "uiMonoFontFamily" | "uiFontSizeScale" | "uiLetterSpacing"
>;

/** Applies `--font-ui`, `--font-mono`, `--ui-font-size`, and `--ui-letter-spacing` on `<html>`. */
export function applyUiTypographyFromSettings(settings: UiTypographySettingsSlice) {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement.style;

  if (settings.uiFontFamily === DEFAULT_UI_FONT_FAMILY) {
    root.removeProperty("--font-ui");
  } else {
    root.setProperty("--font-ui", UI_FONT_STACKS[settings.uiFontFamily]);
  }

  if (settings.uiMonoFontFamily === DEFAULT_UI_MONO_FONT_FAMILY) {
    root.removeProperty("--font-mono");
  } else {
    root.setProperty("--font-mono", MONO_FONT_STACKS[settings.uiMonoFontFamily]);
  }

  if (settings.uiFontSizeScale === DEFAULT_UI_FONT_SIZE_SCALE) {
    root.removeProperty("--ui-font-size");
  } else {
    root.setProperty("--ui-font-size", FONT_SIZE_BY_SCALE[settings.uiFontSizeScale]);
  }

  if (settings.uiLetterSpacing === DEFAULT_UI_LETTER_SPACING) {
    root.removeProperty("--ui-letter-spacing");
  } else {
    root.setProperty("--ui-letter-spacing", LETTER_SPACING_BY_PRESET[settings.uiLetterSpacing]);
  }
}
