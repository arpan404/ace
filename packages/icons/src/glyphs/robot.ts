import { glyph } from "../glyph.ts";
import { ellipse, rect } from "../geometry.ts";
import { line, shape, spot } from "../parts.ts";

/** An agent: Buddy, a round-headed bot with two antennae. */
export const RobotIcon = /* @__PURE__ */ glyph("Robot", () => [
  shape(rect(3, 5.25, 18, 15, 7.25)),
  line("M7.5 5.6 6.25 3M16.5 5.6 17.75 3"),
  spot(ellipse(8.6, 12.9, 1.4, 2)),
  spot(ellipse(15.4, 12.9, 1.4, 2)),
]);
