import { glyph } from "../glyph.ts";
import { arrowhead } from "../geometry.ts";
import { detail } from "../parts.ts";
import { ring } from "./circle.ts";

/** An update: a newer version is ready, an arrow up in a circle. */
export const ArrowCircleUpIcon = /* @__PURE__ */ glyph("ArrowCircleUp", () => [
  ring(),
  detail("M12 16.75V7.75"),
  detail(arrowhead([12, 7.75], -90, 4.5)),
]);
