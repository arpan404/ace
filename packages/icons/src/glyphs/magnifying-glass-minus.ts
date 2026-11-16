import { glyph } from "../glyph.ts";
import { circle, detail, line, shape } from "../parts.ts";

/** Zoom out: the search lens with a minus inside it. */
export const MagnifyingGlassMinusIcon = /* @__PURE__ */ glyph("MagnifyingGlassMinus", () => [
  shape(circle(10.75, 10.75, 7)),
  detail("M8 10.75h5.5"),
  line("M16.25 16.25 20.5 20.5"),
]);
