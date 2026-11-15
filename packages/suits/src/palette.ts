import type { SuitManifest } from "@ace/protocol/suits";
import { customPalette, type Palette, type Scheme } from "@ace/themes";

/*
 * A Suit's colours as a full palette: `customPalette` lays the Suit's colours over its base
 * theme and fits them like a built-in theme, the same function the app draws with, so the
 * checks see what the person sees. Status colours and the danger fill stay ace's (ADR 0150).
 * Every client resolves a Suit through these, so web and the phones draw the same colours.
 */

/** The schemes a Suit has, in a fixed order. */
export function suitSchemes(manifest: Pick<SuitManifest, "light" | "dark">): Scheme[] {
  return (["light", "dark"] as const).filter((scheme) => manifest[scheme] !== undefined);
}

/** The scheme a Suit draws in when `wanted` is asked for: a one-scheme Suit runs only in its own. */
export function suitSchemeFor(
  manifest: Pick<SuitManifest, "light" | "dark">,
  wanted: Scheme,
): Scheme {
  const has = suitSchemes(manifest);
  return has.includes(wanted) ? wanted : (has[0] ?? wanted);
}

/** The Suit's palette in the scheme it draws in for `wanted`. */
export function suitPalette(manifest: SuitManifest, wanted: Scheme): Palette {
  const scheme = suitSchemeFor(manifest, wanted);
  return customPalette(manifest.base, scheme, manifest[scheme] ?? {});
}

/** The device density a Suit asks for; Spacious reads as Comfortable, the roomiest one. */
export function suitDensity(manifest: SuitManifest): "comfortable" | "compact" | undefined {
  const density = manifest.shape?.density;
  if (density === undefined) return undefined;
  return density === "compact" ? "compact" : "comfortable";
}
