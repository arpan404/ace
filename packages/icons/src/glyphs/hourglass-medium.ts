import { glyph } from "../glyph.ts";
import { arc } from "../geometry.ts";
import { dot, line } from "../parts.ts";

/** Waiting: a ring three quarters drawn, around a still centre. */
export const HourglassMediumIcon = /* @__PURE__ */ glyph("HourglassMedium", () => [
  line(arc(12, 12, 8.75, -90, 180)),
  dot(12, 12, 1.6),
]);
