import type { Material, Scheme, ThemeFonts } from "../types.ts";

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

/** Glass floating layers (when Surfaces is Translucent), focus ring at 60% of the accent. */
export const glassy: Record<Scheme, Material> = {
  light: { glass: { blur: 0.64, liquid: 0.56 }, focus: 60 },
  dark: { glass: { blur: 0.68, liquid: 0.62 }, focus: 60 },
};

/** Solid floating layers whatever Surfaces says, and full-strength focus rings. */
export const solid: Record<Scheme, Material> = {
  light: { glass: { blur: 1, liquid: 1 }, focus: 100 },
  dark: { glass: { blur: 1, liquid: 1 }, focus: 100 },
};
