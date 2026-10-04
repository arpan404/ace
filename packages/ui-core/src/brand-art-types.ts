/** One filled outline of a brand mark. */
export interface BrandPath {
  d: string;
  /** Set only in the colour variant; the mono variant fills with the text colour. */
  fill?: string;
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
