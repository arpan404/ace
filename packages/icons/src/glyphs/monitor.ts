import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { line, shape, type Part } from "../parts.ts";

/** A screen, wide; also the base of the desktop computer. */
export const screen = (): Part[] => [shape(rect(2.5, 3.5, 19, 13.5, 3.75))];

/** A display: the screen on a short foot. */
export const MonitorIcon = /* @__PURE__ */ glyph("Monitor", () => [
  ...screen(),
  line("M8.5 20.5h7"),
]);
