import { glyph } from "../glyph.ts";
import { ellipse } from "../geometry.ts";
import { circle, line, shape, spot } from "../parts.ts";

/** Spade's bots: one round bot head with egg eyes, in front of another; not Buddy, the agent. */
export const BotsIcon = /* @__PURE__ */ glyph("Bots", () => [
  line(circle(15.5, 9.25, 6), { hole: circle(9.5, 14, 9.4) }),
  shape(circle(9.5, 14, 7)),
  spot(ellipse(7.2, 13.6, 1.2, 1.7)),
  spot(ellipse(11.8, 13.6, 1.2, 1.7)),
]);
