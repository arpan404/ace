import { readableAcross } from "./colour.ts";
import type { Theme } from "./presets.ts";
import { themeSurfaces } from "./surfaces.ts";
import { tokenGroups } from "./tokens.ts";

const statusTokens = tokenGroups.find((group) => group.name === "Status")?.tokens ?? [];

/**
 * Each status hue as words (`--status-<name>-text`): the hue itself where it already reads at AA
 * on every surface of the theme, else the nearest step of it toward black (light) or white (dark)
 * that does. Status is coloured text with no fill behind it, so this is what keeps "Needs you"
 * legible on a selected row over clear glass, and in a custom theme with a pale hue.
 */
export function statusTextColours(theme: Theme): Record<string, string> {
  const surfaces = themeSurfaces(theme.tokens).map((surface) => surface.rgb);
  const dark = theme.scheme === "dark";
  return Object.fromEntries(
    statusTokens.map((token) => [
      `${token}-text`,
      readableAcross(theme.tokens[token], surfaces, dark) ?? theme.tokens["--foreground"],
    ]),
  );
}
