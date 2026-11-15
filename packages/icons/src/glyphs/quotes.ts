import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { line, shape, type Part } from "../parts.ts";

const mark = (x: number): Part[] => [
  shape(rect(x, 11, 6.5, 6.5, 2)),
  line(`M${x} 13V11.5c0-2.5 1.25-4.25 3.75-5.25`),
];

/** A quote: two opening quotation marks. */
export const QuotesIcon = /* @__PURE__ */ glyph("Quotes", () => [...mark(3.5), ...mark(13.5)]);
