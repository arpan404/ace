/** Mini preview colors for the settings card (dark chrome + accent strip). */
export type ThemePresetPreview = {
  panel: string;
  panelDeep: string;
  accent: string;
  accentMuted: string;
};

/** Twelve unified UI presets (surfaces + primary). */
export const THEME_PRESET_OPTIONS: ReadonlyArray<{
  id:
    | "zenith-light"
    | "zenith-dark"
    | "monochrome-light"
    | "monochrome-dark"
    | "slate"
    | "sandstone"
    | "evergreen"
    | "sakura"
    | "oceanic"
    | "inferno"
    | "stardust"
    | "cyberpunk";
  label: string;
  description: string;
  preview: ThemePresetPreview;
}> = [
  {
    id: "zenith-light",
    label: "Aura",
    description: "Balanced neutral surfaces with a crisp cobalt primary in both modes.",
    preview: {
      panel: "oklch(0.982 0.008 255)",
      panelDeep: "oklch(0.958 0.01 255)",
      accent: "oklch(0.63 0.17 255)",
      accentMuted: "oklch(0.53 0.12 255)",
    },
  },
  {
    id: "zenith-dark",
    label: "Midnight",
    description: "Cool slate palette that shifts from soft daylight to deep night contrast.",
    preview: {
      panel: "oklch(0.205 0.02 255)",
      panelDeep: "oklch(0.155 0.02 255)",
      accent: "oklch(0.7 0.16 255)",
      accentMuted: "oklch(0.59 0.11 255)",
    },
  },
  {
    id: "monochrome-light",
    label: "Graphite",
    description: "Pure grayscale palette tuned for focused reading in light and dark.",
    preview: {
      panel: "oklch(0.985 0 0)",
      panelDeep: "oklch(0.955 0 0)",
      accent: "oklch(0.26 0 0)",
      accentMuted: "oklch(0.46 0 0)",
    },
  },
  {
    id: "monochrome-dark",
    label: "Onyx",
    description: "Higher-contrast monochrome palette with a darker personality across modes.",
    preview: {
      panel: "oklch(0.21 0 0)",
      panelDeep: "oklch(0.16 0 0)",
      accent: "oklch(0.86 0 0)",
      accentMuted: "oklch(0.68 0 0)",
    },
  },
  {
    id: "slate",
    label: "Mist",
    description: "Desaturated blue-gray palette for a calm workspace in any mode.",
    preview: {
      panel: "oklch(0.24 0.012 235)",
      panelDeep: "oklch(0.19 0.012 235)",
      accent: "oklch(0.68 0.1 225)",
      accentMuted: "oklch(0.56 0.075 225)",
    },
  },
  {
    id: "sandstone",
    label: "Dune",
    description: "Warm sand-tinted neutrals with restrained amber highlights day and night.",
    preview: {
      panel: "oklch(0.97 0.01 85)",
      panelDeep: "oklch(0.94 0.01 85)",
      accent: "oklch(0.65 0.09 72)",
      accentMuted: "oklch(0.53 0.07 72)",
    },
  },
  {
    id: "evergreen",
    label: "Forest",
    description: "Natural green palette with earthy depth and mode-aware contrast.",
    preview: {
      panel: "oklch(0.2 0.02 145)",
      panelDeep: "oklch(0.15 0.02 145)",
      accent: "oklch(0.63 0.14 138)",
      accentMuted: "oklch(0.5 0.095 138)",
    },
  },
  {
    id: "sakura",
    label: "Blossom",
    description: "Soft rose and lavender tones with refined surfaces in both modes.",
    preview: {
      panel: "oklch(0.982 0.01 335)",
      panelDeep: "oklch(0.953 0.01 335)",
      accent: "oklch(0.72 0.16 342)",
      accentMuted: "oklch(0.58 0.11 342)",
    },
  },
  {
    id: "oceanic",
    label: "Tide",
    description: "Marine blues with clear cyan accents, balanced for light and dark.",
    preview: {
      panel: "oklch(0.2 0.02 205)",
      panelDeep: "oklch(0.15 0.02 205)",
      accent: "oklch(0.67 0.14 195)",
      accentMuted: "oklch(0.53 0.095 195)",
    },
  },
  {
    id: "inferno",
    label: "Ember",
    description: "Smoky charcoal and ember-orange accents that stay readable in both modes.",
    preview: {
      panel: "oklch(0.16 0.02 35)",
      panelDeep: "oklch(0.12 0.02 35)",
      accent: "oklch(0.69 0.16 35)",
      accentMuted: "oklch(0.56 0.11 35)",
    },
  },
  {
    id: "stardust",
    label: "Nebula",
    description: "Muted indigo-violet palette with luminous accents across both modes.",
    preview: {
      panel: "oklch(0.16 0.02 285)",
      panelDeep: "oklch(0.11 0.02 285)",
      accent: "oklch(0.7 0.16 300)",
      accentMuted: "oklch(0.57 0.11 300)",
    },
  },
  {
    id: "cyberpunk",
    label: "Neon Night",
    description: "Futuristic neon palette with dedicated light and dark variants.",
    preview: {
      panel: "oklch(0.14 0.03 265)",
      panelDeep: "oklch(0.1 0.03 265)",
      accent: "oklch(0.72 0.19 322)",
      accentMuted: "oklch(0.58 0.13 322)",
    },
  },
];

export type ThemePresetId = (typeof THEME_PRESET_OPTIONS)[number]["id"];

export const DEFAULT_THEME_PRESET: ThemePresetId = "zenith-light";

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
