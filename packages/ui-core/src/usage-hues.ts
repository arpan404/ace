/*
 * Provider hues for the Usage page's lines, bars and swatches, light and dark. Codex takes the
 * theme's muted ink (null), so it follows every theme, as does a provider without a hue.
 * The web reads the same values from `apps/web/src/styles/usage.css`.
 */

export interface UsageHue {
  light: string;
  dark: string;
}

const hues: Record<string, UsageHue> = {
  claude: { light: "#c15f3c", dark: "#e2865c" },
  opencode: { light: "#0f8a84", dark: "#3cc4bd" },
  cursor: { light: "#6b6f80", dark: "#a3a7b8" },
  pi: { light: "#1f9d6b", dark: "#4fc58f" },
  acp: { light: "#2c66d6", dark: "#7aa7ff" },
  antigravity: { light: "#7c5bd6", dark: "#a58cf0" },
};

/** The provider's hue; null for the theme's ink (Codex) or its muted ink (any other). */
export function usageHue(provider: string): UsageHue | null {
  return hues[provider] ?? null;
}
