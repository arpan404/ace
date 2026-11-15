import { glyph } from "../glyph.ts";
import { circle, line, shape } from "../parts.ts";

/** A group: a person in front with one more on each side. */
export const UsersThreeIcon = /* @__PURE__ */ glyph("UsersThree", () => {
  const front = circle(12, 9, 5.6);
  return [
    line(circle(5.5, 8, 2.4), { hole: front }),
    line(circle(18.5, 8, 2.4), { hole: front }),
    line("M2.5 18.5c0-2.5 1.3-4 3.4-4.2M21.5 18.5c0-2.5-1.3-4-3.4-4.2"),
    shape(circle(12, 9, 3.1)),
    shape("M6.5 20.25c0-3.3 2.4-5.25 5.5-5.25s5.5 1.95 5.5 5.25Z"),
  ];
});
