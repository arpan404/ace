import { glyph } from "../glyph.ts";
import { detail } from "../parts.ts";
import { square } from "./check-square.ts";

/** A new tab: a plus in a square. */
export const PlusSquareIcon = /* @__PURE__ */ glyph("PlusSquare", () => [
  square(),
  detail("M12 8v8M8 12h8"),
]);
