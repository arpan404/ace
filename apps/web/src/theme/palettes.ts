import { deriveAccent } from "./accent-fit.ts";
import { oklchToHex, parseOpaqueColor, readableAcross, rgbToOklch } from "./colour.ts";
import { ace } from "./sources/ace.ts";
import { folio } from "./sources/folio.ts";
import { harbor } from "./sources/harbor.ts";
import { signal } from "./sources/signal.ts";
import { tty } from "./sources/tty.ts";
import { umbra } from "./sources/umbra.ts";
import { glassTintAlpha } from "./glass-floor.ts";
import { paletteSurfaces } from "./surfaces.ts";
import type {
  Base,
  Material,
  Palette,
  Scheme,
  SchemeSource,
  ThemeDefinition,
  ThemeSource,
} from "./types.ts";

export { rampSteps } from "./types.ts";
export { sharedStatus } from "./status.ts";
export type {
  Accent,
  Base,
  Material,
  Palette,
  PaletteColour,
  Ramp,
  RampStep,
  Scheme,
  StatusSet,
  Syntax,
  ThemeDefinition,
  ThemeFonts,
} from "./types.ts";

/*
 * The themes (docs/design/visual-language.md, "Themes"). A theme is a material, not an accent:
 * each one owns its neutral ramp, contrast, status hues, code colours, fonts and glass, and its
 * own accent. Every colour comes from the theme's source table in `sources/`; the only derived
 * values are the pressed accent and the shadow tint. Another accent is a separate choice
 * (`accent.ts`) fitted over any theme. Every palette passes WCAG AA on every surface
 * (`contrast.ts`).
 */

const rgb = (hex: string) => parseOpaqueColor(hex) ?? ([0, 0, 0] as const);

/** The pressed fill continues past hover by half a hover-sized step in lightness. */
function pressed(accent: string, hover: string): string {
  const [rest, over] = [rgbToOklch(rgb(accent)), rgbToOklch(rgb(hover))];
  const l = Math.min(1, Math.max(0, over.l + (over.l - rest.l) / 2));
  return oklchToHex(l, rest.c, rest.h);
}

/** "r g b" of the shadow: the ink in light schemes, black in dark ones. */
function shadowTint(source: SchemeSource, scheme: Scheme): string {
  if (scheme === "dark") return "0 0 0";
  return rgb(source.text).join(" ");
}

/**
 * The sources clear AA on the prototype's surfaces (page, sidebar, cards, floating, hover,
 * active, code). The app also draws text on glass and on selected-row washes, and needs faint
 * icons at 3:1, so a role that falls short there steps toward black (light) or white (dark)
 * just far enough; one that passes keeps its source value exactly.
 */
function fitted(draft: Palette, scheme: Scheme): Palette {
  const dark = scheme === "dark";
  const page = parseOpaqueColor(draft.s0);
  const faint = page ? readableAcross(draft.faint, [page], dark, 3) : undefined;
  const surfacesOf = (p: Palette) => paletteSurfaces(p, scheme).map((surface) => surface.rgb);
  // The ink comes first: selected rows are a wash of it, so the other roles fit to its result.
  const text = readableAcross(draft.text, surfacesOf(draft), dark) ?? draft.text;
  const inked: Palette = { ...draft, text, t1: text, faint: faint ?? draft.faint };
  const surfaces = surfacesOf(inked);
  const words = (colour: string) => readableAcross(colour, surfaces, dark) ?? text;
  const muted = words(draft.muted);
  const subtle = words(draft.subtle);
  return {
    ...inked,
    muted,
    t2: muted,
    subtle,
    t3: subtle,
    accentText: words(draft.accentText),
    workingText: words(draft.workingText),
    needsText: words(draft.needsText),
    doneText: words(draft.doneText),
    failedText: words(draft.failedText),
  };
}

function palette(source: SchemeSource, scheme: Scheme, material: Material): Palette {
  // The glass is solved against the designed text, before any fitting: fitting only moves text
  // further from the surfaces, so the tint stays thick enough and never shifts with it.
  const glassTint = glassTintAlpha(
    { s2: source.raised, t1: source.text, t2: source.muted, t3: source.subtle, material },
    scheme,
  );
  const draft: Palette = {
    glassTint,
    ...source,
    s0: source.canvas,
    s1: source.surface,
    s2: source.raised,
    t1: source.text,
    t2: source.muted,
    t3: source.subtle,
    accentPressed: pressed(source.accent, source.accentHover),
    shadow: shadowTint(source, scheme),
    material,
  };
  return fitted(draft, scheme);
}

/** A palette with `accentColour` fitted to it (AA labels, marks and links on its surfaces). */
export function withAccent(base: Base, scheme: Scheme, accentColour: string): Palette {
  return { ...base, ...deriveAccent(accentColour, scheme, base) };
}

function theme(source: ThemeSource): ThemeDefinition {
  return {
    name: source.name,
    character: source.character,
    fonts: source.fonts,
    accent: { light: source.light.accent, dark: source.dark.accent },
    light: palette(source.light, "light", source.material.light),
    dark: palette(source.dark, "dark", source.material.dark),
  };
}

/** In the order Settings shows them, the default first. */
export const themeIds = ["ace", "folio", "umbra", "signal", "tty", "harbor"] as const;
export type ThemeId = (typeof themeIds)[number];
export const defaultThemeId: ThemeId = "ace";

export const themes: Record<ThemeId, ThemeDefinition> = {
  ace: theme(ace),
  folio: theme(folio),
  umbra: theme(umbra),
  signal: theme(signal),
  tty: theme(tty),
  harbor: theme(harbor),
};
