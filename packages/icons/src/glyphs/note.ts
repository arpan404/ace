import { glyph } from "../glyph.ts";
import { polygon } from "../geometry.ts";
import { detail, shape } from "../parts.ts";

/** A note: a square sheet with its lower corner folded. */
export const NoteIcon = /* @__PURE__ */ glyph("Note", () => [
  shape(
    polygon([
      [3.5, 3.5, 4.5],
      [20.5, 3.5, 4.5],
      [20.5, 14.5, 0.8],
      [14.5, 20.5, 0.8],
      [3.5, 20.5, 4.5],
    ]),
  ),
  detail("M14.5 20.1V16.5a2 2 0 0 1 2-2h3.6"),
]);
