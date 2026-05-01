/** Mini preview colors for the settings card (dark chrome + accent strip). */
export type ThemePresetPreview = {
  panel: string;
  panelDeep: string;
  accent: string;
  accentMuted: string;
};

/** Twelve unified UI presets: 4 neutrals + 8 accents. */
export const THEME_PRESET_OPTIONS: ReadonlyArray<{
  id:
    | "obsidian"
    | "neutral"
    | "ember"
    | "glass"
    | "midnight"
    | "aurora"
    | "nebula"
    | "horizon"
    | "evergreen"
    | "solaris"
    | "vermillion"
    | "graphite";
  label: string;
  description: string;
  preview: ThemePresetPreview;
}> = [
  /* ── Neutrals ── */
  {
    id: "obsidian",
    label: "Obsidian",
    description: "Classic neutral with sharp cobalt accents.",
    preview: {
      panel: "oklch(0.17 0 0)",
      panelDeep: "oklch(0.13 0 0)",
      accent: "oklch(0.68 0.17 250)",
      accentMuted: "oklch(0.38 0 0)",
    },
  },
  {
    id: "neutral",
    label: "Neutral",
    description: "Pure black or white surfaces with a monochrome primary.",
    preview: {
      panel: "oklch(0.14 0 0)",
      panelDeep: "oklch(0.05 0 0)",
      accent: "oklch(0.88 0 0)",
      accentMuted: "oklch(0.4 0 0)",
    },
  },
  {
    id: "ember",
    label: "Ember",
    description: "Warm neutral with amber-orange accents.",
    preview: {
      panel: "oklch(0.17 0 0)",
      panelDeep: "oklch(0.13 0 0)",
      accent: "oklch(0.74 0.18 40)",
      accentMuted: "oklch(0.56 0.1 40)",
    },
  },
  {
    id: "glass",
    label: "Glass",
    description: "Neutral frosted layers: white or charcoal bases with soft gray glass.",
    preview: {
      panel: "oklch(0.24 0 0)",
      panelDeep: "oklch(0.15 0 0)",
      accent: "oklch(0.8 0 0)",
      accentMuted: "oklch(0.66 0 0)",
    },
  },
  /* ── Accents ── */
  {
    id: "midnight",
    label: "Midnight",
    description: "Deep indigo for late-night sessions.",
    preview: {
      panel: "oklch(0.18 0.025 265)",
      panelDeep: "oklch(0.14 0.02 265)",
      accent: "oklch(0.68 0.18 265)",
      accentMuted: "oklch(0.55 0.012 265)",
    },
  },
  {
    id: "aurora",
    label: "Aurora",
    description: "Cool cyan inspired by northern lights.",
    preview: {
      panel: "oklch(0.18 0.025 180)",
      panelDeep: "oklch(0.14 0.02 180)",
      accent: "oklch(0.7 0.14 180)",
      accentMuted: "oklch(0.55 0.012 180)",
    },
  },
  {
    id: "nebula",
    label: "Nebula",
    description: "Cosmic violet for creative flow.",
    preview: {
      panel: "oklch(0.18 0.025 295)",
      panelDeep: "oklch(0.14 0.02 295)",
      accent: "oklch(0.72 0.18 295)",
      accentMuted: "oklch(0.55 0.012 295)",
    },
  },
  {
    id: "horizon",
    label: "Horizon",
    description: "Warm rose-tinted workspace.",
    preview: {
      panel: "oklch(0.18 0.025 5)",
      panelDeep: "oklch(0.14 0.02 5)",
      accent: "oklch(0.72 0.16 5)",
      accentMuted: "oklch(0.55 0.012 5)",
    },
  },
  {
    id: "evergreen",
    label: "Evergreen",
    description: "Natural forest tones for focused work.",
    preview: {
      panel: "oklch(0.18 0.025 150)",
      panelDeep: "oklch(0.14 0.02 150)",
      accent: "oklch(0.65 0.14 150)",
      accentMuted: "oklch(0.55 0.012 150)",
    },
  },
  {
    id: "solaris",
    label: "Solaris",
    description: "Golden amber glow for warm sessions.",
    preview: {
      panel: "oklch(0.18 0.025 75)",
      panelDeep: "oklch(0.14 0.02 75)",
      accent: "oklch(0.76 0.15 75)",
      accentMuted: "oklch(0.55 0.012 75)",
    },
  },
  {
    id: "vermillion",
    label: "Vermillion",
    description: "Bold crimson energy.",
    preview: {
      panel: "oklch(0.18 0.025 25)",
      panelDeep: "oklch(0.14 0.02 25)",
      accent: "oklch(0.7 0.18 25)",
      accentMuted: "oklch(0.55 0.012 25)",
    },
  },
  {
    id: "graphite",
    label: "Graphite",
    description: "Industrial steel-gray, minimal distraction.",
    preview: {
      panel: "oklch(0.18 0.02 240)",
      panelDeep: "oklch(0.14 0.015 240)",
      accent: "oklch(0.63 0.08 240)",
      accentMuted: "oklch(0.55 0.01 240)",
    },
  },
];

export type ThemePresetId = (typeof THEME_PRESET_OPTIONS)[number]["id"];

export const DEFAULT_THEME_PRESET: ThemePresetId = "obsidian";

const PRESET_ID_SET = new Set<string>(THEME_PRESET_OPTIONS.map((o) => o.id));

export function isThemePresetId(value: string): value is ThemePresetId {
  return PRESET_ID_SET.has(value);
}

export function parseThemePresetId(raw: string | null): ThemePresetId {
  if (raw === "terminal") {
    return "glass";
  }
  if (raw && isThemePresetId(raw)) {
    return raw;
  }
  return DEFAULT_THEME_PRESET;
}
