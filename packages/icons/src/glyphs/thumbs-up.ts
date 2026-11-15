import { glyph } from "../glyph.ts";
import { polygon, rect, type Vertex } from "../geometry.ts";
import { shape, type Part } from "../parts.ts";

const hand: readonly Vertex[] = [
  [8.75, 10.25, 1],
  [11.4, 3.5, 1.4],
  [13.6, 4.5, 1.6],
  [13.2, 9.25, 0.8],
  [18.75, 9.25, 2],
  [20.6, 11.6, 1.6],
  [19, 20.25, 2],
  [8.75, 20.25, 1],
];

/** A fist with its thumb up, and its cuff; `down` turns it over. */
export const thumb = (down: boolean): Part[] => {
  const flip = (v: Vertex): Vertex => (down ? [v[0], 24 - v[1], v[2]] : v);
  return [
    shape(down ? rect(3.25, 3.75, 3.5, 10, 1.25) : rect(3.25, 10.25, 3.5, 10, 1.25)),
    shape(polygon(hand.map(flip))),
  ];
};

/** A thumbs-up reaction. */
export const ThumbsUpIcon = /* @__PURE__ */ glyph("ThumbsUp", () => thumb(false));
