import { glyph } from "../glyph.ts";
import { circle, line, shape } from "../parts.ts";

/** Search: a lens and its handle. */
export const MagnifyingGlassIcon = /* @__PURE__ */ glyph("MagnifyingGlass", () => [
  shape(circle(10.75, 10.75, 7)),
  line("M16.25 16.25 20.5 20.5"),
]);
