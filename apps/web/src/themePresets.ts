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
  /** Broad grouping shown as a section header in the picker. */
  family: "signature" | "editor" | "accent";
  preview: ThemePresetPreview;
};

/** All selectable color presets. "ace" is the signature base palette (index.css);
 *  every other preset layers a fully re-tinted palette (surfaces, accent, semantic
 *  colors AND terminal ANSI) for both light and dark in theme-presets.css.
 *
 *  The non-Ace palettes are faithful to their namesake editor themes: dark uses the
 *  canonical colors, light is a coherent companion built from the same hues. */
export const THEME_PRESET_OPTIONS = [
  {
    id: "ace",
    label: "Ace",
    description:
      "The signature palette — deep near-black dark, clean off-white light, electric blue accent.",
    family: "signature",
    preview: {
      panel: "#1f2937",
      panelDeep: "#111827",
      accent: "#4f8cff",
      accentMuted: "#3f6fd0",
    },
  },
  {
    id: "xcode",
    label: "Xcode",
    description: "Apple's developer palette — cool graphite surfaces with an azure keyword accent.",
    family: "editor",
    preview: {
      panel: "#292a30",
      panelDeep: "#1f1f24",
      accent: "#6ba1ff",
      accentMuted: "#5384d6",
    },
  },
  {
    id: "github",
    label: "GitHub",
    description: "The GitHub palette — inky slate dark, crisp light, signature blue accent.",
    family: "editor",
    preview: {
      panel: "#161b22",
      panelDeep: "#0d1117",
      accent: "#58a6ff",
      accentMuted: "#388bfd",
    },
  },
  {
    id: "dracula",
    label: "Dracula",
    description: "The iconic vampire palette — muted indigo night with a vivid purple accent.",
    family: "editor",
    preview: {
      panel: "#282a36",
      panelDeep: "#21222c",
      accent: "#bd93f9",
      accentMuted: "#9d7cd8",
    },
  },
  {
    id: "monokai",
    label: "Monokai",
    description: "Warm charcoal surfaces with the classic acid-green and magenta highlights.",
    family: "editor",
    preview: {
      panel: "#2d2e27",
      panelDeep: "#221f1a",
      accent: "#a6e22e",
      accentMuted: "#8bbf27",
    },
  },
  {
    id: "solarized",
    label: "Solarized",
    description: "Ethan Schoonover's precision palette — teal-tinted base with a calm blue accent.",
    family: "editor",
    preview: {
      panel: "#073642",
      panelDeep: "#002b36",
      accent: "#268bd2",
      accentMuted: "#2076b4",
    },
  },
  {
    id: "nord",
    label: "Nord",
    description: "Arctic, north-bluish palette — polar-night surfaces with a frost accent.",
    family: "editor",
    preview: {
      panel: "#3b4252",
      panelDeep: "#2e3440",
      accent: "#88c0d0",
      accentMuted: "#81a1c1",
    },
  },
  {
    id: "one-dark",
    label: "One Dark",
    description: "Atom's beloved palette — soft slate surfaces with a clear cyan-blue accent.",
    family: "editor",
    preview: {
      panel: "#282c34",
      panelDeep: "#21252b",
      accent: "#61afef",
      accentMuted: "#528bce",
    },
  },
  {
    id: "gruvbox",
    label: "Gruvbox",
    description: "Retro, warm and earthy — brown-charcoal surfaces with a golden accent.",
    family: "editor",
    preview: {
      panel: "#32302f",
      panelDeep: "#1d2021",
      accent: "#fabd2f",
      accentMuted: "#d79921",
    },
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    description:
      "Neon dusk over the city — deep blue-violet surfaces with a soft periwinkle accent.",
    family: "editor",
    preview: {
      panel: "#24283b",
      panelDeep: "#1a1b26",
      accent: "#7aa2f7",
      accentMuted: "#6a8de0",
    },
  },
  {
    id: "catppuccin",
    label: "Catppuccin",
    description: "Soothing pastel palette (Mocha) — cozy lavender-charcoal with a mauve accent.",
    family: "editor",
    preview: {
      panel: "#1e1e2e",
      panelDeep: "#181825",
      accent: "#cba6f7",
      accentMuted: "#b48ee8",
    },
  },
  {
    id: "ayu",
    label: "Ayu",
    description: "Crisp and modern — ink-blue surfaces with a warm amber accent.",
    family: "editor",
    preview: {
      panel: "#1f2430",
      panelDeep: "#0f1419",
      accent: "#ffcc66",
      accentMuted: "#f0b846",
    },
  },
  {
    id: "green",
    label: "Green",
    description: "Ace's neutral surfaces with a fresh emerald accent.",
    family: "accent",
    preview: {
      panel: "#1f2937",
      panelDeep: "#111827",
      accent: "#10b981",
      accentMuted: "#0f9d6f",
    },
  },
  {
    id: "orange",
    label: "Orange",
    description: "Ace's neutral surfaces with a warm amber accent.",
    family: "accent",
    preview: {
      panel: "#1f2937",
      panelDeep: "#111827",
      accent: "#f59e0b",
      accentMuted: "#d98607",
    },
  },
  {
    id: "red",
    label: "Red",
    description: "Ace's neutral surfaces with a bold red accent.",
    family: "accent",
    preview: {
      panel: "#1f2937",
      panelDeep: "#111827",
      accent: "#ef4444",
      accentMuted: "#d13636",
    },
  },
  {
    id: "pink",
    label: "Pink",
    description: "Ace's neutral surfaces with a vivid pink accent.",
    family: "accent",
    preview: {
      panel: "#1f2937",
      panelDeep: "#111827",
      accent: "#ec4899",
      accentMuted: "#d43a86",
    },
  },
  {
    id: "violet",
    label: "Violet",
    description: "Ace's neutral surfaces with a rich violet accent.",
    family: "accent",
    preview: {
      panel: "#1f2937",
      panelDeep: "#111827",
      accent: "#8b5cf6",
      accentMuted: "#7a4de0",
    },
  },
  {
    id: "cyan",
    label: "Cyan",
    description: "Ace's neutral surfaces with a cool cyan accent.",
    family: "accent",
    preview: {
      panel: "#1f2937",
      panelDeep: "#111827",
      accent: "#22bcd4",
      accentMuted: "#1aa6bd",
    },
  },
] as const satisfies ReadonlyArray<ThemePresetOption>;

export type ThemePresetId = (typeof THEME_PRESET_OPTIONS)[number]["id"];

export const DEFAULT_THEME_PRESET: ThemePresetId = "ace";

const PRESET_ID_SET = new Set<string>(THEME_PRESET_OPTIONS.map((o) => o.id));

function isThemePresetId(value: string): value is ThemePresetId {
  return PRESET_ID_SET.has(value);
}

/** Parse a stored preset id; anything unknown (including legacy ids) falls back to Ace. */
export function parseThemePresetId(raw: string | null): ThemePresetId {
  return raw && isThemePresetId(raw) ? raw : DEFAULT_THEME_PRESET;
}
