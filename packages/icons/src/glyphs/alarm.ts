import { glyph } from "../glyph.ts";
import { circle, line, shape } from "../parts.ts";
import { clockHands } from "./clock.ts";

/** A wake-up time: an alarm clock with its two bells and feet. */
export const AlarmIcon = /* @__PURE__ */ glyph("Alarm", () => [
  shape(circle(12, 12.75, 7.5)),
  clockHands(12, 13),
  line("M3.25 6.5 6.5 3.25M17.5 3.25l3.25 3.25"),
  line("M7.6 19.25 6.25 21M16.4 19.25 17.75 21"),
]);
