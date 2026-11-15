import { glyph } from "../glyph.ts";
import { line } from "../parts.ts";

/** A quote: the quoted lines beside a bar. */
export const QuotesIcon = /* @__PURE__ */ glyph("Quotes", () => [
  line("M5 5v14"),
  line("M9.5 7h9.5M9.5 12h9.5M9.5 17h6"),
]);
