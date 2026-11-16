import { glyph } from "../glyph.ts";
import { polygon, rect, turned } from "../geometry.ts";
import { shape, type Part } from "../parts.ts";

/** The front card's box. */
const front = { x: 3.25, y: 8, width: 11.5, height: 13.5, radius: 3.25 } as const;

/** The front card's area and a clear margin round it, as bands a stroke can cut. */
const behindFront = (): string => {
  const { x, y, width, height, radius } = front;
  return `${rect(x, y, width, height, radius)}${rect(x + 3, y + 3, width - 6, height - 6, 1)}M${x + width / 2} ${y + 5.5}V${y + height - 5.5}`;
};

/** The card behind, leaning right, cut clear where the front card covers it. */
const backCard = (): Part => ({
  role: "line",
  outline: polygon(
    turned(
      [
        [9.25, 2.5, 3.25],
        [19.75, 2.5, 3.25],
        [19.75, 15, 3.25],
        [9.25, 15, 3.25],
      ],
      12,
      14.5,
      8.75,
    ),
  ),
  gap: { path: behindFront(), width: 3.5 },
});

/** A collection: a card fanned out in front of another. */
export const CardsIcon = /* @__PURE__ */ glyph("Cards", () => [
  backCard(),
  shape(rect(front.x, front.y, front.width, front.height, front.radius)),
]);
