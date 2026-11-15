import { glyph } from "../glyph.ts";
import { circle, detail, shape, type Part } from "../parts.ts";

/** An open eye and its iris; also the base of "hide". */
export const eye = (): Part[] => [
  shape(
    "M2.5 12C4.75 7.6 8 5.25 12 5.25s7.25 2.35 9.5 6.75c-2.25 4.4-5.5 6.75-9.5 6.75S4.75 16.4 2.5 12Z",
  ),
  detail(circle(12, 12, 3.25)),
];

/** Show, or watch: an open eye. */
export const EyeIcon = /* @__PURE__ */ glyph("Eye", eye);
