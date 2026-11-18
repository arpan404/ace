import type { SuitFont } from "@ace/protocol/suits";

/*
 * The font families a Suit sets, as its review names them: once each, unquoted, without the
 * generic families or the fallbacks a CSS stack lists after the one it wants. Pure.
 */

/** CSS's generic families and the system aliases a stack ends on; none is a font it brings. */
const generic = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
  "-apple-system",
  "blinkmacsystemfont",
  "inherit",
  "initial",
  "unset",
]);

/** A CSS `font-family` value's families, in order, unquoted, split on commas outside quotes. */
function families(stack: string): string[] {
  const found: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const char of stack) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ",") {
      found.push(current);
      current = "";
    } else current += char;
  }
  found.push(current);
  return found.map((family) => family.trim().replace(/\s+/g, " ")).filter(Boolean);
}

/** The family a stack asks for: its first that isn't generic; undefined when all are. */
export function leadFamily(stack: string): string | undefined {
  return families(stack).find((family) => !generic.has(family.toLowerCase()));
}

/** Each family a Suit's fonts set, once, in the order its fonts list them. */
export function suitFontFamilies(fonts: readonly (SuitFont | undefined)[]): string[] {
  const named = fonts.flatMap((font) => {
    if (!font) return [];
    const family = "family" in font ? leadFamily(font.family) : leadFamily(font.system);
    return family ? [family] : [];
  });
  const seen = new Set<string>();
  return named.filter((family) => {
    const key = family.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
