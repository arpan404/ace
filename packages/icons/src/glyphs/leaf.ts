import { glyph } from "../glyph.ts";
import { detail, line, shape } from "../parts.ts";

/** Growth: a leaf on a short stem. */
export const LeafIcon = /* @__PURE__ */ glyph("Leaf", () => [
  shape("M5.5 18.5C4.75 9.5 9.5 4.25 20.25 3.75 19.75 14.5 14.5 19.25 5.5 18.5Z"),
  detail("M9 15 15.25 8.75"),
  line("M3.25 20.75 5.5 18.5"),
]);
