import type { GlassMaterial, Material, Scheme, ThemeFonts } from "../types.ts";

/* Font stacks and floating materials the theme sources share. System fonts only. */

const sans =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const mono = '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace';
const serif = '"New York", ui-serif, "Iowan Old Style", Charter, Georgia, serif';

/** Sans interface and transcript, monospace code. */
export const sansFonts: ThemeFonts = { ui: sans, prose: sans, mono };
/** Sans interface, serif transcript prose. */
export const folioFonts: ThemeFonts = { ui: sans, prose: serif, mono };
/** Monospace everywhere. */
export const ttyFonts: ThemeFonts = { ui: mono, prose: mono, mono };

/**
 * Glass floating layers (while Translucency is above Solid) with a backdrop of `light` and `dark`
 * frosting, and focus rings at 60% of the accent. Dark schemes blur a little more: dark glass
 * over bright content shows more of it.
 */
export function glassy(light: GlassMaterial, dark: GlassMaterial): Record<Scheme, Material> {
  return {
    light: { glass: light, focus: 60 },
    dark: { glass: dark, focus: 60 },
  };
}

/** Solid floating layers whatever Surfaces says, and full-strength focus rings. */
export const solid: Record<Scheme, Material> = {
  light: { glass: null, focus: 100 },
  dark: { glass: null, focus: 100 },
};
