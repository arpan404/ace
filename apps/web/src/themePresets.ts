/** Mini preview colors for the settings card (dark chrome + accent strip). */
export type ThemePresetPreview = {
  panel: string;
  panelDeep: string;
  accent: string;
  accentMuted: string;
};

/** Unified UI preset. */
export const THEME_PRESET_OPTIONS: ReadonlyArray<{
  id: "glass";
  label: string;
  description: string;
  preview: ThemePresetPreview;
}> = [
  {
    id: "glass",
    label: "Glass",
    description: "Frosted neutral chrome: soft gray canvas, white panels, monochrome accents.",
    preview: {
      panel: "oklch(0.975 0 0)",
      panelDeep: "oklch(0.955 0 0)",
      accent: "oklch(0.88 0 0)",
      accentMuted: "oklch(0.62 0 0)",
    },
  },
];

export type ThemePresetId = (typeof THEME_PRESET_OPTIONS)[number]["id"];

export const DEFAULT_THEME_PRESET: ThemePresetId = "glass";

const PRESET_ID_SET = new Set<string>(THEME_PRESET_OPTIONS.map((o) => o.id));

function isThemePresetId(value: string): value is ThemePresetId {
  return PRESET_ID_SET.has(value);
}

export function parseThemePresetId(raw: string | null): ThemePresetId {
  if (raw && isThemePresetId(raw)) {
    return raw;
  }
  return DEFAULT_THEME_PRESET;
}
