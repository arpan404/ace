import type { BrowserAnnotationConfig } from "@ace/protocol";

/** Colours resolved from @ace/design-tokens on the daemon side, per theme. */
export interface OverlayPalette {
  /** Bar and editor accent (Send, focus, caret): the theme's ring token. */
  accent: string;
  onAccent: string;
  /**
   * Markers and outlines sit on page content, not on ace chrome, so they use one saturated
   * accent with a white ring in both themes.
   */
  mark: string;
  onMark: string;
  /** `mark` at low alpha, the fill inside an element outline. */
  markWash: string;
  glass: string;
  edge: string;
  text: string;
  muted: string;
  hover: string;
  danger: string;
  shadow: string;
  /** Ring around markers so they read on any page. */
  ring: string;
}

export interface OverlayTokens {
  font: string;
  radii: { small: number; card: number; pill: number };
  motion: { fast: number; standard: number; enter: string };
}

/** Everything the page side needs to start: JSON only, built by `annotationInstallExpression`. */
export interface OverlayInit {
  binding: string;
  palettes: { light: OverlayPalette; dark: OverlayPalette };
  tokens: OverlayTokens;
  config: Partial<BrowserAnnotationConfig>;
}
