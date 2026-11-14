import type { SuitManifest } from "@ace/protocol/suits";
import { customPalette, type Palette, type Scheme } from "@ace/themes";

/*
 * A Suit's colours as a full palette: `customPalette` lays the Suit's colours over its base
 * theme and fits them like a built-in theme, the same function the app draws with, so the
 * checks see what the person sees. Status colours and the danger fill stay ace's (ADR 0150).
 */

/** The schemes a Suit has, in a fixed order. */
export function suitSchemes(manifest: Pick<SuitManifest, "light" | "dark">): Scheme[] {
  return (["light", "dark"] as const).filter((scheme) => manifest[scheme] !== undefined);
}

/** The palette of `scheme` for a Suit. */
export function suitPalette(manifest: SuitManifest, scheme: Scheme): Palette {
  return customPalette(manifest.base, scheme, manifest[scheme] ?? {});
}
