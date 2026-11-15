import { glyph } from "../glyph.ts";
import { circle, detail, line, shape } from "../parts.ts";

/** A scheduled run: a stopwatch with its crown and one hand. */
export const TimerIcon = /* @__PURE__ */ glyph("Timer", () => [
  shape(circle(12, 13.25, 8)),
  detail("M12 13.25 14.75 10.5"),
  line("M9.75 2.75h4.5M12 2.75v2.5"),
]);
