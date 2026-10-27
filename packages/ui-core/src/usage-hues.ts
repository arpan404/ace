/*
 * Provider hues for the Usage page's lines, bars and swatches, light and dark. Codex is the
 * theme's ink (null), so it follows every theme; a provider without a hue takes the muted ink.
 * The web reads the same values from `apps/web/src/styles/usage.css`.
 */

export interface UsageHue {
  light: string;
  dark: string;
}

const hues: Record<string, UsageHue> = {
  claude: { light: "#c15f3c", dark: "#e08a68" },
  opencode: { light: "#2f6fdf", dark: "#6b9cf5" },
  cursor: { light: "#6b6f80", dark: "#a3a7b8" },
  pi: { light: "#1f9d6b", dark: "#4fc58f" },
  acp: { light: "#7c5bd6", dark: "#a58cf0" },
  antigravity: { light: "#7c5bd6", dark: "#a58cf0" },
};

/** The provider's hue; null for the theme's ink (Codex) or its muted ink (any other). */
export function usageHue(provider: string): UsageHue | null {
  return hues[provider] ?? null;
}
