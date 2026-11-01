/*
 * Provider hues for the Usage page's lines, bars and swatches, light and dark. Codex takes the
 * theme's muted ink (null), so it follows every theme, as does a provider without a hue.
 * The web reads the same values from `apps/web/src/styles/usage.css` (as oklch; these are their
 * sRGB equivalents).
 */

export interface UsageHue {
  light: string;
  dark: string;
}

const hues: Record<string, UsageHue> = {
  claude: { light: "#b7684c", dark: "#da8f74" },
  acp: { light: "#5174af", dark: "#84a6dd" },
  opencode: { light: "#80719e", dark: "#ab9bcb" },
  pi: { light: "#628c6a", dark: "#8cb894" },
  cursor: { light: "#738292", dark: "#97a7b7" },
  antigravity: { light: "#956991", dark: "#c293bd" },
};

/** The provider's hue; null for the theme's ink (Codex) or its muted ink (any other). */
export function usageHue(provider: string): UsageHue | null {
  return hues[provider] ?? null;
}
