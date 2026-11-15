import { glyph } from "../glyph.ts";
import { polygon } from "../geometry.ts";
import { line, shape } from "../parts.ts";

/** A queue: lines waiting in turn, the last beside a play mark. */
export const QueueIcon = /* @__PURE__ */ glyph("Queue", () => [
  line("M3.5 6h17M3.5 12h17M3.5 18h7"),
  shape(
    polygon([
      [15, 14.5, 1],
      [20.5, 17.75, 1],
      [15, 21, 1],
    ]),
  ),
]);
