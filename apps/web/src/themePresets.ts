/** Mini preview colors for the settings card (dark chrome + accent strip). */
export type ThemePresetPreview = {
  panel: string;
  panelDeep: string;
  accent: string;
  accentMuted: string;
};

/** Twelve unified UI presets: 3 neutrals + 9 accents. */
export const THEME_PRESET_OPTIONS: ReadonlyArray<{
  id:
    | "zinc"
    | "copper"
    | "jade"
    | "indigo"
    | "rose"
    | "amber"
    | "teal"
    | "violet"
    | "sage"
    | "crimson"
    | "azure"
    | "slate";
  label: string;
  description: string;
  preview: ThemePresetPreview;
}> = [
  /* ── Neutrals ── */
  {
    id: "zinc",
    label: "Zinc",
    description: "Clean gray with blue accents.",
    preview: {
      panel: "oklch(0.17 0 0)",
      panelDeep: "oklch(0.13 0 0)",
      accent: "oklch(0.68 0.17 250)",
      accentMuted: "oklch(0.55 0.12 250)",
    },
  },
  {
    id: "copper",
    label: "Copper",
    description: "Clean gray with warm orange accents.",
    preview: {
      panel: "oklch(0.17 0 0)",
      panelDeep: "oklch(0.13 0 0)",
      accent: "oklch(0.75 0.17 45)",
      accentMuted: "oklch(0.6 0.12 45)",
    },
  },
  {
    id: "jade",
    label: "Jade",
    description: "Clean gray with emerald accents.",
    preview: {
      panel: "oklch(0.17 0 0)",
      panelDeep: "oklch(0.13 0 0)",
      accent: "oklch(0.68 0.16 155)",
      accentMuted: "oklch(0.55 0.1 155)",
    },
  },
  /* ── Accents ── */
  {
    id: "indigo",
    label: "Indigo",
    description: "Rich indigo-tinted workspace.",
    preview: {
      panel: "oklch(0.18 0.025 275)",
      panelDeep: "oklch(0.14 0.02 275)",
      accent: "oklch(0.7 0.17 275)",
      accentMuted: "oklch(0.58 0.015 275)",
    },
  },
  {
    id: "rose",
    label: "Rose",
    description: "Warm rose-tinted workspace.",
    preview: {
      panel: "oklch(0.18 0.025 350)",
      panelDeep: "oklch(0.14 0.02 350)",
      accent: "oklch(0.72 0.16 350)",
      accentMuted: "oklch(0.58 0.015 350)",
    },
  },
  {
    id: "amber",
    label: "Amber",
    description: "Golden amber-tinted workspace.",
    preview: {
      panel: "oklch(0.18 0.025 80)",
      panelDeep: "oklch(0.14 0.02 80)",
      accent: "oklch(0.75 0.16 80)",
      accentMuted: "oklch(0.58 0.015 80)",
    },
  },
  {
    id: "teal",
    label: "Teal",
    description: "Cool teal-tinted workspace.",
    preview: {
      panel: "oklch(0.18 0.025 190)",
      panelDeep: "oklch(0.14 0.02 190)",
      accent: "oklch(0.7 0.14 190)",
      accentMuted: "oklch(0.58 0.015 190)",
    },
  },
  {
    id: "violet",
    label: "Violet",
    description: "Ethereal violet-tinted workspace.",
    preview: {
      panel: "oklch(0.18 0.025 300)",
      panelDeep: "oklch(0.14 0.02 300)",
      accent: "oklch(0.72 0.17 300)",
      accentMuted: "oklch(0.58 0.015 300)",
    },
  },
  {
    id: "sage",
    label: "Sage",
    description: "Natural sage-tinted workspace.",
    preview: {
      panel: "oklch(0.18 0.025 145)",
      panelDeep: "oklch(0.14 0.02 145)",
      accent: "oklch(0.68 0.14 145)",
      accentMuted: "oklch(0.58 0.015 145)",
    },
  },
  {
    id: "crimson",
    label: "Crimson",
    description: "Bold crimson-tinted workspace.",
    preview: {
      panel: "oklch(0.18 0.025 25)",
      panelDeep: "oklch(0.14 0.02 25)",
      accent: "oklch(0.7 0.17 25)",
      accentMuted: "oklch(0.58 0.015 25)",
    },
  },
  {
    id: "azure",
    label: "Azure",
    description: "Airy blue-tinted workspace.",
    preview: {
      panel: "oklch(0.18 0.025 225)",
      panelDeep: "oklch(0.14 0.02 225)",
      accent: "oklch(0.7 0.16 225)",
      accentMuted: "oklch(0.58 0.015 225)",
    },
  },
  {
    id: "slate",
    label: "Slate",
    description: "Cool steel-tinted workspace.",
    preview: {
      panel: "oklch(0.18 0.025 240)",
      panelDeep: "oklch(0.14 0.02 240)",
      accent: "oklch(0.65 0.1 240)",
      accentMuted: "oklch(0.58 0.015 240)",
    },
  },
];

export type ThemePresetId = (typeof THEME_PRESET_OPTIONS)[number]["id"];

export const DEFAULT_THEME_PRESET: ThemePresetId = "zinc";

const PRESET_ID_SET = new Set<string>(THEME_PRESET_OPTIONS.map((o) => o.id));

export function isThemePresetId(value: string): value is ThemePresetId {
  return PRESET_ID_SET.has(value);
}

export function parseThemePresetId(raw: string | null): ThemePresetId {
  if (raw && isThemePresetId(raw)) {
    return raw;
  }
  return DEFAULT_THEME_PRESET;
}
