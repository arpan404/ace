import { glyph } from "../glyph.ts";
import { shape } from "../parts.ts";

/** Extensions, or a tool: a jigsaw piece, knobs out on its top and right, a socket on its left. */
export const PuzzlePieceIcon = /* @__PURE__ */ glyph("PuzzlePiece", () => [
  shape(
    "M6.25 7h2.5a2.25 2.25 0 1 1 3.5 0h2.5a2.25 2.25 0 0 1 2.25 2.25v2.5a2.25 2.25 0 1 1 0 3.5v2.5a2.25 2.25 0 0 1-2.25 2.25h-8.5A2.25 2.25 0 0 1 4 17.75v-2.5a2.25 2.25 0 1 0 0-3.5v-2.5A2.25 2.25 0 0 1 6.25 7Z",
  ),
]);
