/** A gradient fill as the brand's SVG defines it, so every renderer can draw it the same way. */
export interface BrandGradient {
  type: "linear" | "radial";
  /** SVG attributes by their SVG names: x1, y1, x2, y2, cx, cy, r, gradientUnits… */
  attributes: Readonly<Record<string, string>>;
  stops: readonly { offset: string; color: string; opacity?: number }[];
}

/** One filled outline of a brand mark. */
export interface BrandPath {
  d: string;
  /**
   * Set only in the colour variant: a solid fill or a gradient. Without either the path fills
   * with the text colour, as every mono path does.
   */
  fill?: string;
  gradient?: BrandGradient;
  fillRule?: "evenodd";
  clipRule?: "evenodd";
  opacity?: number;
}

/** A brand mark as plain path data, so the web app and React Native draw it the same way. */
export interface BrandArt {
  viewBox: string;
  mono: readonly BrandPath[];
  /** The brand's own colours, when its mark has them. */
  color?: readonly BrandPath[];
}
