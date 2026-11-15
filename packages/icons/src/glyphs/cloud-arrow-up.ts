import { glyph } from "../glyph.ts";
import { arrowhead } from "../geometry.ts";
import { detail, shape } from "../parts.ts";

/** Push: an arrow up inside a cloud. */
export const CloudArrowUpIcon = /* @__PURE__ */ glyph("CloudArrowUp", () => [
  shape("M7.5 19A4.25 4.25 0 0 1 7.26 10.51A5.75 5.75 0 0 1 18.66 11.26A4 4 0 0 1 17.25 19Z"),
  detail("M12.5 16.5V11.25"),
  detail(arrowhead([12.5, 11.25], -90, 3.5)),
]);
