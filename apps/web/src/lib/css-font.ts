/** The parts of a computed style a font is made of. */
export interface FontStyle {
  font: string;
  fontStyle: string;
  fontWeight: string;
  fontSize: string;
  fontFamily: string;
}

/**
 * The font to measure text in, as a canvas or a `font:` declaration takes it. Chromium reports
 * the `font` shorthand empty when the font sets features or variants (`font-feature-settings`,
 * as a Suit's code font may), so it is rebuilt from its parts then.
 */
export function cssFont(style: FontStyle): string {
  if (style.font) return style.font;
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}
