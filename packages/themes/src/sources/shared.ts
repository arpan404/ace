import type { Material, Scheme, ThemeFonts } from "../types.ts";

/* What every theme shares: themes are colour only, so fonts and floating materials are common. */

const sans =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const mono = '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace';

/** Sans interface and transcript, monospace code. System fonts only. */
export const sansFonts: ThemeFonts = { ui: sans, prose: sans, mono };

/**
 * Glass floating layers (while Translucency is above Solid) and focus rings at 60% of the
 * accent. Dark glass blurs a little more: over bright content it shows more of it.
 */
export const themeMaterial: Record<Scheme, Material> = {
  light: { glass: { blur: 24, saturate: 170 }, focus: 60 },
  dark: { glass: { blur: 28, saturate: 160 }, focus: 60 },
};
