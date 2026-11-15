import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { line } from "../parts.ts";

/** A numbered list: a 1 and a 2 beside three lines. */
export const ListNumbersIcon = /* @__PURE__ */ glyph("ListNumbers", () => [
  line(
    polyline([
      [3.5, 5],
      [5.75, 3.5, 0.6],
      [5.75, 10],
    ]),
  ),
  line("M3.5 15.75A2.15 2.15 0 1 1 7.25 17.2L3.5 20.5H7.75"),
  line("M11 6h9.5M11 12h9.5M11 18h9.5"),
]);
