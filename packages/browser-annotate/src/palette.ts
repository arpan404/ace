import { designTokens } from "@ace/design-tokens";
import type { OverlayPalette, OverlayTokens } from "./init.ts";

function rgba(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

function palette(scheme: "light" | "dark"): OverlayPalette {
  const { colours, status, opacity } = designTokens.schemes[scheme];
  const page = designTokens.schemes.light.colours;
  return {
    accent: colours.accent,
    onAccent: colours.onAccent,
    mark: page.accent,
    onMark: page.onAccent,
    markWash: rgba(page.accent, 0.08),
    // Floating layers are glass with an edge and a shadow (DESIGN.md); over arbitrary page
    // content the glass is slightly denser than ace's own chrome so text stays legible.
    glass: rgba(colours.glass, Math.min(0.92, opacity.glass + 0.14)),
    edge: scheme === "dark" ? rgba(colours.foreground, 0.1) : colours.separator,
    text: colours.foreground,
    muted: colours.mutedForeground,
    hover: rgba(colours.foreground, opacity.ripple / 1.5),
    danger: status.failed,
    shadow: rgba(colours.shadow, scheme === "dark" ? 0.45 : 0.14),
    ring: page.background,
  };
}

/** Overlay colours for both schemes, from @ace/design-tokens. */
export function overlayPalettes(): { light: OverlayPalette; dark: OverlayPalette } {
  return { light: palette("light"), dark: palette("dark") };
}

export function overlayTokens(): OverlayTokens {
  const { typography, radii, motion } = designTokens;
  const [a, b, c, d] = motion.easing.enter;
  return {
    font: `"${typography.family}", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`,
    mono: `"${typography.monoFamily}", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
    radii: { small: radii.small, card: radii.card, pill: radii.pill },
    motion: {
      fast: motion.fast,
      standard: motion.standard,
      enter: `cubic-bezier(${a}, ${b}, ${c}, ${d})`,
    },
  };
}
