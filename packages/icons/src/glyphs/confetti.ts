import { glyph } from "../glyph.ts";
import { polygon } from "../geometry.ts";
import { dot, line, shape } from "../parts.ts";

/** A hooray reaction: a party popper throwing confetti. */
export const ConfettiIcon = /* @__PURE__ */ glyph("Confetti", () => [
  shape(
    polygon([
      [3.25, 20.75, 0.8],
      [7.5, 9, 1.2],
      [15, 16.5, 1.2],
    ]),
  ),
  line("M11.5 7.75c.9-1.2.6-2.6 1.5-3.9M16.25 12.5c1.2-.9 2.6-.6 3.9-1.5M14 10l4-4"),
  dot(17.25, 3.5, 1.15),
  dot(20.5, 7.25, 1.15),
]);
