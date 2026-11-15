import { glyph } from "../glyph.ts";
import { line, plussed } from "../parts.ts";

/** Something new in a list: three lines with a plus. */
export const ListPlusIcon = /* @__PURE__ */ glyph("ListPlus", () =>
  plussed([line("M3.5 6h17M3.5 12h10M3.5 18h7.5")]),
);
