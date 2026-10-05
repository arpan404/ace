import type { Appearance } from "./appearance.ts";
import { readableAcross, readableOn } from "./colour.ts";
import type { Theme } from "./presets.ts";
import { themeSurfaces } from "./surfaces.ts";
import type { TokenName } from "./tokens.ts";

export interface AccentColours {
  /** The accent itself (`--ring`): fills, focus rings, selection, sliders. */
  ring: string;
  /** Labels on an accent fill (`--ring-foreground`), black or white: always AA. */
  foreground: string;
  /**
   * The accent as text (`--ring-text`: links, the current rail view): the accent, moved toward
   * the text colour just enough to read at AA on every surface of the theme. A custom white
   * accent on Light still gives readable links.
   */
  text: string;
}

export function accentColours(
  theme: Theme,
  appearance: Pick<Appearance, "accent" | "customAccent">,
): AccentColours {
  const token: TokenName =
    appearance.accent === "theme" || appearance.accent === "custom"
      ? "--accent-theme"
      : `--accent-${appearance.accent}`;
  const ring = appearance.accent === "custom" ? appearance.customAccent : theme.tokens[token];
  const surfaces = themeSurfaces(theme.tokens).map((surface) => surface.rgb);
  return {
    ring,
    foreground: readableOn(ring),
    text: readableAcross(ring, surfaces, theme.scheme === "dark") ?? theme.tokens["--foreground"],
  };
}
