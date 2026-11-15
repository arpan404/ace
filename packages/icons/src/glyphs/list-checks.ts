import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { line, type Part } from "../parts.ts";

const tick = (y: number): Part =>
  line(
    polyline([
      [3.5, y],
      [5.5, y + 2, 0.6],
      [9, y - 2],
    ]),
  );

/** Tasks: ticks beside lines. */
export const ListChecksIcon = /* @__PURE__ */ glyph("ListChecks", () => [
  tick(6.5),
  tick(15.5),
  line("M12.5 6.5h8M12.5 15.5h8"),
]);
