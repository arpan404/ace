/** Mini preview colors for the settings picker (theme chip + accent letters). */
export type ThemePresetPreview = {
  panel: string;
  panelDeep: string;
  accent: string;
  accentMuted: string;
};

export type ThemePresetOption = {
  id: ThemePresetId;
  label: string;
  description: string;
  preview: ThemePresetPreview;
};

/** All selectable color presets. "neutral" is the base palette (index.css);
 *  the rest layer tinted overrides in theme-presets.css. */
export const THEME_PRESET_OPTIONS = [
  {
    id: "neutral",
    label: "Neutral",
    description: "Refined grayscale — deep near-black dark, clean off-white light.",
    preview: {
      panel: "oklch(0.205 0 0)",
      panelDeep: "oklch(0.17 0 0)",
      accent: "oklch(0.68 0.16 252)",
      accentMuted: "oklch(0.6 0.13 252)",
    },
  },
  {
    id: "midnight",
    label: "Midnight",
    description: "Deep blue-black chrome with a cool azure accent.",
    preview: {
      panel: "oklch(0.205 0.024 262)",
      panelDeep: "oklch(0.17 0.022 262)",
      accent: "oklch(0.66 0.16 258)",
      accentMuted: "oklch(0.58 0.13 258)",
    },
  },
  {
    id: "slate",
    label: "Slate",
    description: "Cool, desaturated blue-gray. Calm and understated.",
    preview: {
      panel: "oklch(0.22 0.01 240)",
      panelDeep: "oklch(0.185 0.008 240)",
      accent: "oklch(0.66 0.1 235)",
      accentMuted: "oklch(0.58 0.09 235)",
    },
  },
  {
    id: "warm",
    label: "Warm",
    description: "Charcoal-warm surfaces with a soft amber accent.",
    preview: {
      panel: "oklch(0.215 0.01 72)",
      panelDeep: "oklch(0.18 0.008 72)",
      accent: "oklch(0.78 0.13 75)",
      accentMuted: "oklch(0.68 0.11 72)",
    },
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  description: string;
  preview: ThemePresetPreview;
}>;

export type ThemePresetId = (typeof THEME_PRESET_OPTIONS)[number]["id"];

export const DEFAULT_THEME_PRESET: ThemePresetId = "neutral";

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
