import { glyph } from "../glyph.ts";
import { circle, detail, dot, shape, type Part } from "../parts.ts";

/** A round face with two eyes and the mouth given. */
export const face = (mouth: string): Part[] => [
  shape(circle(12, 12, 9.25)),
  dot(9, 10, 1.25),
  dot(15, 10, 1.25),
  detail(mouth),
];

/** A laugh reaction: a smiling face. */
export const SmileyIcon = /* @__PURE__ */ glyph("Smiley", () =>
  face("M8.5 14.25c.85 1.5 2 2.25 3.5 2.25s2.65-.75 3.5-2.25"),
);
