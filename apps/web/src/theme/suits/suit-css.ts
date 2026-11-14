import type { SuitDetail, SuitFont, SuitManifest } from "@ace/protocol/suits";
import {
  customPalette,
  themeSources,
  type Palette,
  type Scheme,
  type ThemeFonts,
  type ThemeId,
} from "@ace/themes";
import { declarationBlock, paletteDeclarations } from "../css.ts";
import { defaultTranslucency } from "../translucency.ts";

/*
 * A Suit (ADR 0150) as the page's CSS: its palettes laid over the base theme and run through
 * the same token path as a built-in theme, so status, row-status and danger tokens stay ace's
 * own. Shape and motion scale the shared radius and duration tokens (styles/tokens.css,
 * styles/motion.css); fonts are bundled files or system stacks, never remote. Pure.
 */

const schemes: readonly Scheme[] = ["light", "dark"];

/** Suit bases are the built-in theme ids. */
export const suitBaseTheme = (manifest: SuitManifest): ThemeId => manifest.base;

/** The schemes a Suit has, light first. */
export function suitSchemes(manifest: SuitManifest): Scheme[] {
  return schemes.filter((scheme) => manifest[scheme] !== undefined);
}

/** The scheme a Suit draws in when `wanted` is asked for: a one-scheme Suit runs only in its own. */
export function suitSchemeFor(manifest: SuitManifest, wanted: Scheme): Scheme {
  const has = suitSchemes(manifest);
  return has.includes(wanted) ? wanted : (has[0] ?? wanted);
}

/** The Suit's palette in the scheme it draws in for `wanted`. */
export function suitPalette(manifest: SuitManifest, wanted: Scheme): Palette {
  const scheme = suitSchemeFor(manifest, wanted);
  return customPalette(suitBaseTheme(manifest), scheme, manifest[scheme] ?? {});
}

/** An internal family name per slot, so a bundled font never shadows an installed one. */
const faceName = (id: string, slot: keyof ThemeFonts) => `ace-suit-${id}-${slot}`;

/** A served URL a stylesheet may load: http(s) or a same-origin path, nothing that breaks out. */
function safeUrl(url: string): string | undefined {
  if (/["'\\()\s]/.test(url)) return undefined;
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

const formats: Record<string, string> = {
  woff2: "woff2",
  woff: "woff",
  ttf: "truetype",
  otf: "opentype",
};

/** One family of a system stack: a quoted name or a bare keyword, with no characters that end a rule. */
const stackPart = /^(?:"[A-Za-z0-9 ._-]+"|'[A-Za-z0-9 ._-]+'|[A-Za-z0-9-]+(?: [A-Za-z0-9-]+)*)$/;

/** A system font stack as given, if every family in it is safe to place in a stylesheet. */
function systemStack(stack: string): string | undefined {
  const parts = stack.split(",").map((part) => part.trim());
  return parts.length > 0 && parts.every((part) => stackPart.test(part))
    ? parts.join(", ")
    : undefined;
}

interface FontPlan {
  /** `@font-face` rules for bundled files. */
  faces: string[];
  fonts: ThemeFonts;
}

function fontPlan(detail: Pick<SuitDetail, "manifest" | "assets">): FontPlan {
  const { manifest, assets } = detail;
  const base = themeSources[suitBaseTheme(manifest)].fonts;
  const faces: string[] = [];
  const stack = (slot: keyof ThemeFonts, font: SuitFont | undefined): string => {
    if (!font) return base[slot];
    if ("system" in font) {
      const given = systemStack(font.system);
      return given ? `${given}, ${base[slot]}` : base[slot];
    }
    const served = assets[font.asset];
    const url = served === undefined ? undefined : safeUrl(served);
    if (!url) return base[slot];
    const extension = font.asset.split(".").pop()?.toLowerCase() ?? "";
    const format = formats[extension];
    const name = faceName(manifest.id, slot);
    faces.push(
      `@font-face{font-family:"${name}";src:url("${url}")${format ? ` format("${format}")` : ""};font-display:swap}`,
    );
    return `"${name}", ${base[slot]}`;
  };
  const fonts = manifest.fonts;
  return {
    faces,
    fonts: {
      ui: stack("ui", fonts?.ui),
      prose: stack("prose", fonts?.prose),
      mono: stack("mono", fonts?.mono),
    },
  };
}

/** Shape and motion as the scales the shared tokens read. */
function shapeDeclarations(manifest: SuitManifest): Record<string, string> {
  return {
    "--radius-scale": String(manifest.shape?.radius ?? 1),
    "--border-weight": `${manifest.shape?.border ?? 1}px`,
    "--motion-scale": String(manifest.motion?.speed ?? 1),
  };
}

/** Every declaration the Suit sets when the page asks for `wanted`. */
export function suitDeclarations(
  detail: Pick<SuitDetail, "manifest" | "assets">,
  wanted: Scheme,
  translucency = defaultTranslucency,
): Record<string, string> {
  const { manifest } = detail;
  const scheme = suitSchemeFor(manifest, wanted);
  return {
    ...paletteDeclarations(
      suitPalette(manifest, scheme),
      scheme,
      fontPlan(detail).fonts,
      translucency,
    ),
    ...shapeDeclarations(manifest),
  };
}

/**
 * The Suit as one stylesheet: its font faces, then a rule per scheme that matches an element
 * carrying `data-suit` and `data-scheme`. A one-scheme Suit's palette answers both schemes, so
 * the page never shows the base theme while it settles on the Suit's scheme.
 */
export function suitStylesheet(
  detail: Pick<SuitDetail, "manifest" | "assets">,
  translucency = defaultTranslucency,
): string {
  const { faces } = fontPlan(detail);
  const rules = schemes.map(
    (scheme) =>
      `[data-suit="${detail.manifest.id}"][data-scheme="${scheme}"]{${declarationBlock(suitDeclarations(detail, scheme, translucency))}}`,
  );
  return [...faces, ...rules].join("\n");
}

/** Density as the app has it: Spacious draws as Comfortable, the roomiest the app has. */
export function suitDensity(manifest: SuitManifest): "comfortable" | "compact" | undefined {
  const density = manifest.shape?.density;
  if (density === undefined) return undefined;
  return density === "compact" ? "compact" : "comfortable";
}
