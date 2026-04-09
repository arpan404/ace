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
    label: "Zenith Light",
    description: "A bright, clean, and modern light theme. The default experience.",
    preview: {
      panel: "oklch(0.98 0.01 240)",
      panelDeep: "oklch(0.95 0.01 240)",
      accent: "oklch(0.6 0.17 250)",
      accentMuted: "oklch(0.45 0.12 250)",
    },
  },
  {
    id: "zenith-dark",
    label: "Zenith Dark",
    description: "A polished and professional dark theme, the counterpart to Zenith Light.",
    preview: {
      panel: "oklch(0.2 0.02 240)",
      panelDeep: "oklch(0.15 0.02 240)",
      accent: "oklch(0.7 0.17 250)",
      accentMuted: "oklch(0.55 0.12 250)",
    },
  },
  {
    id: "monochrome-light",
    label: "Monochrome Light",
    description: "A minimalist theme using only shades of gray, for a clean, focused look.",
    preview: {
      panel: "oklch(0.98 0 0)",
      panelDeep: "oklch(0.95 0 0)",
      accent: "oklch(0.2 0 0)",
      accentMuted: "oklch(0.4 0 0)",
    },
  },
  {
    id: "monochrome-dark",
    label: "Monochrome Dark",
    description: "A dark, minimalist theme using only shades of gray.",
    preview: {
      panel: "oklch(0.2 0 0)",
      panelDeep: "oklch(0.15 0 0)",
      accent: "oklch(0.9 0 0)",
      accentMuted: "oklch(0.7 0 0)",
    },
  },
  {
    id: "slate",
    label: "Slate",
    description: "A cool, blue-gray theme inspired by slate rock, with very low saturation.",
    preview: {
      panel: "oklch(0.25 0.01 230)",
      panelDeep: "oklch(0.2 0.01 230)",
      accent: "oklch(0.7 0.1 220)",
      accentMuted: "oklch(0.55 0.08 220)",
    },
  },
  {
    id: "sandstone",
    label: "Sandstone",
    description: "A warm, beige-gray theme inspired by sandstone, with very low saturation.",
    preview: {
      panel: "oklch(0.95 0.01 80)",
      panelDeep: "oklch(0.92 0.01 80)",
      accent: "oklch(0.6 0.1 70)",
      accentMuted: "oklch(0.45 0.08 70)",
    },
  },
  {
    id: "evergreen",
    label: "Evergreen",
    description: "A calming theme inspired by nature, with green and brown tones.",
    preview: {
      panel: "oklch(0.2 0.02 140)",
      panelDeep: "oklch(0.15 0.02 140)",
      accent: "oklch(0.6 0.15 130)",
      accentMuted: "oklch(0.45 0.1 130)",
    },
  },
  {
    id: "sakura",
    label: "Sakura",
    description: "A soft and playful theme inspired by cherry blossoms, with pink and purple tones.",
    preview: {
      panel: "oklch(0.98 0.01 330)",
      panelDeep: "oklch(0.95 0.01 330)",
      accent: "oklch(0.7 0.18 340)",
      accentMuted: "oklch(0.55 0.12 340)",
    },
  },
  {
    id: "oceanic",
    label: "Oceanic",
    description: "A deep and immersive theme with blues and teals inspired by the ocean.",
    preview: {
      panel: "oklch(0.2 0.02 200)",
      panelDeep: "oklch(0.15 0.02 200)",
      accent: "oklch(0.65 0.15 190)",
      accentMuted: "oklch(0.5 0.1 190)",
    },
  },
  {
    id: "inferno",
    label: "Inferno",
    description: "A bold, high-contrast dark theme with warm reds and oranges.",
    preview: {
      panel: "oklch(0.15 0.03 30)",
      panelDeep: "oklch(0.1 0.03 30)",
      accent: "oklch(0.7 0.2 20)",
      accentMuted: "oklch(0.55 0.15 20)",
    },
  },
  {
    id: "stardust",
    label: "Stardust",
    description: "A cosmic dark theme with a deep purple/blue background and sparkling accents.",
    preview: {
      panel: "oklch(0.15 0.02 280)",
      panelDeep: "oklch(0.1 0.02 280)",
      accent: "oklch(0.7 0.18 300)",
      accentMuted: "oklch(0.55 0.12 300)",
    },
  },
  {
    id: "cyberpunk",
    label: "Cyberpunk",
    description: "A futuristic theme with neon blues, pinks, and purples against a dark background.",
    preview: {
      panel: "oklch(0.15 0.03 260)",
      panelDeep: "oklch(0.1 0.03 260)",
      accent: "oklch(0.7 0.2 320)",
      accentMuted: "oklch(0.55 0.15 320)",
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
