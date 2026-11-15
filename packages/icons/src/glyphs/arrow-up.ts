import { glyph } from "../glyph.ts";
import { arrowhead, type Point } from "../geometry.ts";
import { line, type Part } from "../parts.ts";

/** The head of a full-size arrow. */
export const fullHead = 6.25;
/** The head of an arrow drawn in a pair, or inside something else. */
export const smallHead = 4.5;

/** A straight arrow from `tail` to `tip`, with the set's head. */
export function arrow(tail: Point, tip: Point, head = fullHead): Part[] {
  const degrees = (Math.atan2(tip[1] - tail[1], tip[0] - tail[0]) * 180) / Math.PI;
  return [line(`M${tail[0]} ${tail[1]} ${tip[0]} ${tip[1]}`), line(arrowhead(tip, degrees, head))];
}

/** Send: an arrow up. */
export const ArrowUpIcon = /* @__PURE__ */ glyph("ArrowUp", () => [
  line("M12 19.5V5"),
  line(arrowhead([12, 5], -90, 6.25)),
]);
