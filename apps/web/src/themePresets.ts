/** Mini preview colors for the settings picker (theme chip + accent letters). */
export type ThemePresetPreview = {
  panel: string;
  panelDeep: string;
  accent: string;
  accentMuted: string;
};

export type ThemePresetFamily = "signature" | "editor" | "accent";

export type ThemePresetOption = {
  id: string;
  label: string;
  description: string;
  family: ThemePresetFamily;
  preview: ThemePresetPreview;
};

/** All selectable color presets. "ace" is the signature base palette (index.css);
 *  every other preset layers a fully re-tinted palette (surfaces, accent, semantic
 *  colors AND terminal ANSI) for both light and dark in theme-presets.css.
 *
 *  Editor-family presets are readable neutral schemes. Some ids are legacy names so
 *  saved preferences continue to resolve after palette replacements. */
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
    label: "OLED Black",
    description: "True-black surfaces for OLED displays with a crisp blue focus accent.",
    family: "editor",
    preview: {
      panel: "#080808",
      panelDeep: "#000000",
      accent: "#8ab4ff",
      accentMuted: "#5f86d6",
    },
  },
  {
    id: "monokai",
    label: "Graphite",
    description: "Dense graphite surfaces with quiet contrast and a neutral steel accent.",
    family: "editor",
    preview: {
      panel: "#1d2024",
      panelDeep: "#111317",
      accent: "#cbd5e1",
      accentMuted: "#94a3b8",
    },
  },
  {
    id: "solarized",
    label: "Paper",
    description: "Soft paper-light surfaces and ink-dark contrast for long reading sessions.",
    family: "editor",
    preview: {
      panel: "#f8f5ef",
      panelDeep: "#ebe7dd",
      accent: "#52616b",
      accentMuted: "#6b7280",
    },
  },
  {
    id: "nord",
    label: "Fog",
    description: "Cool neutral grays with restrained blue-gray accents and clear hierarchy.",
    family: "editor",
    preview: {
      panel: "#252a31",
      panelDeep: "#171b21",
      accent: "#9aa7b8",
      accentMuted: "#748295",
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
    label: "Warm Gray",
    description: "Low-glare warm neutrals with a readable brass accent.",
    family: "editor",
    preview: {
      panel: "#292724",
      panelDeep: "#171614",
      accent: "#d6b06d",
      accentMuted: "#a9874f",
    },
  },
  {
    id: "tokyo-night",
    label: "Midnight",
    description: "Near-black navy surfaces with high-contrast foregrounds and a calm blue accent.",
    family: "editor",
    preview: {
      panel: "#101624",
      panelDeep: "#060913",
      accent: "#93c5fd",
      accentMuted: "#60a5fa",
    },
  },
  {
    id: "catppuccin",
    label: "Slate",
    description: "Balanced slate surfaces with muted accents and strong text contrast.",
    family: "editor",
    preview: {
      panel: "#172033",
      panelDeep: "#0f172a",
      accent: "#94a3b8",
      accentMuted: "#64748b",
    },
  },
  {
    id: "ayu",
    label: "Zinc",
    description: "Sharp neutral zinc surfaces with minimal color and maximum readability.",
    family: "editor",
    preview: {
      panel: "#18181b",
      panelDeep: "#09090b",
      accent: "#e4e4e7",
      accentMuted: "#a1a1aa",
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
