import { glyph } from "../glyph.ts";
import { detail, dot } from "../parts.ts";
import { ring } from "./circle.ts";

/** About, or a note: a lower-case i in a circle. */
export const InfoIcon = /* @__PURE__ */ glyph("Info", () => [
  ring(),
  detail("M12 11v5.5"),
  dot(12, 7.75, 1.2),
]);
