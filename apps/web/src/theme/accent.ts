import type { Appearance } from "./appearance.ts";
import { readableOn } from "./colour.ts";
import type { Theme } from "./presets.ts";
import type { TokenName } from "./tokens.ts";

/**
 * The accent on screen and the text that reads on a fill of it. The accent (`--ring`) draws
 * focus rings, selection, primary actions, checked controls, sliders and links.
 */
export function accentColours(
  theme: Theme,
  appearance: Pick<Appearance, "accent" | "customAccent">,
): { ring: string; foreground: string } {
  const token: TokenName =
    appearance.accent === "theme" || appearance.accent === "custom"
      ? "--accent-theme"
      : `--accent-${appearance.accent}`;
  const ring = appearance.accent === "custom" ? appearance.customAccent : theme.tokens[token];
  return { ring, foreground: readableOn(ring) };
}
