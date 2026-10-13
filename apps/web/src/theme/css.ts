import { themeAccent, themedPalette, type AccentChoice } from "./accent.ts";
import { readableAcross } from "./colour.ts";
import { themeIds, themes, type Palette, type Scheme, type ThemeId } from "./palettes.ts";
import { paletteSurfaces } from "./surfaces.ts";
import { themeTokens } from "./tokens.ts";
import { defaultTranslucency } from "./translucency.ts";

const schemes: readonly Scheme[] = ["light", "dark"];

/**
 * Waiting and not-responding are shared hues, so their words are made readable per theme: the
 * hue itself where it reads at AA on every surface, else the nearest step toward the text colour.
 */
function sharedStatusText(palette: Palette, scheme: Scheme, tokens: Record<string, string>) {
  const surfaces = paletteSurfaces(palette, scheme).map((surface) => surface.rgb);
  const text = (hue: string) => readableAcross(hue, surfaces, scheme === "dark") ?? palette.t1;
  return {
    "--status-waiting-text": text(tokens["--status-waiting"] ?? palette.t1),
    "--status-unresponsive-text": text(tokens["--status-unresponsive"] ?? palette.t1),
  };
}

/** Every declaration one theme sets in one scheme with an accent, as the page receives it. */
export function themeDeclarations(
  id: ThemeId,
  scheme: Scheme,
  accent: AccentChoice = themeAccent,
  translucency = defaultTranslucency,
): Record<string, string> {
  const palette = themedPalette(id, scheme, accent);
  const tokens: Record<string, string> = themeTokens(palette, scheme, translucency);
  const { fonts } = themes[id];
  return {
    "color-scheme": scheme,
    ...tokens,
    // The theme's type: Folio sets transcript prose in a serif, Tty sets everything in mono.
    "--font-sans": fonts.ui,
    "--font-prose": fonts.prose,
    "--font-mono": fonts.mono,
    ...sharedStatusText(palette, scheme, tokens),
    // shadcn's foreground aliases, so components only ever read token names.
    "--card-foreground": palette.t1,
    "--popover-foreground": palette.t1,
    "--secondary-foreground": palette.t1,
    "--accent-foreground": palette.t1,
    "--sidebar-primary": palette.t1,
    "--sidebar-primary-foreground": palette.s0,
    "--sidebar-accent-foreground": palette.t1,
  };
}

/**
 * One theme in one scheme as a rule. It matches any element carrying both attributes, so
 * `<html>` themes the app and a swatch can preview another theme with the same tokens.
 */
export function themeRule(
  id: ThemeId,
  scheme: Scheme,
  accent: AccentChoice = themeAccent,
  translucency = defaultTranslucency,
): string {
  const body = Object.entries(themeDeclarations(id, scheme, accent, translucency))
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
  return `[data-theme="${id}"][data-scheme="${scheme}"]{${body}}`;
}

/**
 * Both schemes of one theme: what the boot record replays before first paint, its glass at the
 * chosen translucency.
 */
export function themeStylesheet(
  id: ThemeId,
  accent: AccentChoice = themeAccent,
  translucency = defaultTranslucency,
): string {
  return schemes.map((scheme) => themeRule(id, scheme, accent, translucency)).join("\n");
}

/** Every theme in both schemes with one accent, for the app and the theme swatches. */
export function themesStylesheet(accent: AccentChoice = themeAccent): string {
  return themeIds.map((id) => themeStylesheet(id, accent)).join("\n");
}
