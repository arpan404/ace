import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { line } from "../parts.ts";

const bracket = (x: number, y: number, dx: number, dy: number) =>
  line(
    polyline([
      [x, y + dy * 4],
      [x, y, 2],
      [x + dx * 4, y],
    ]),
  );

/** Annotate an element: a focus frame around a note. */
export const CursorClickIcon = /* @__PURE__ */ glyph("CursorClick", () => [
  bracket(3.5, 3.5, 1, 1),
  bracket(20.5, 3.5, -1, 1),
  bracket(3.5, 20.5, 1, -1),
  bracket(20.5, 20.5, -1, -1),
  line("M8.5 10h7M8.5 14h4.5"),
]);
