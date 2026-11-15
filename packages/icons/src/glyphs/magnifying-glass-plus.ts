import { glyph } from "../glyph.ts";
import { circle, detail, line, shape } from "../parts.ts";

/** Zoom in: the search lens with a plus inside it. */
export const MagnifyingGlassPlusIcon = /* @__PURE__ */ glyph("MagnifyingGlassPlus", () => [
  shape(circle(10.75, 10.75, 7)),
  detail("M10.75 8v5.5M8 10.75h5.5"),
  line("M16.25 16.25 20.5 20.5"),
]);
