import { glyph } from "../glyph.ts";
import { polyline, type Point } from "../geometry.ts";
import { line, type Part } from "../parts.ts";

/** A point in the link's own frame: `u` along the diagonal toward the upper right, `v` across it. */
const at = (u: number, v: number): Point => [12 + (u + v) / Math.SQRT2, 12 + (v - u) / Math.SQRT2];

/** One half of the chain, on the lower left (`side` -1) or upper right (`side` 1), its open end `reach` from the middle. */
export function linkHalf(side: number, reach: number): Part {
  const end = side * reach;
  const far = side * 9.25;
  return line(
    polyline([
      [...at(end, 3.4)],
      [...at(far, 3.4), 3.4],
      [...at(far, -3.4), 3.4],
      [...at(end, -3.4)],
    ]),
  );
}

/** A link: two halves of a chain joined by a bar. */
export const link = (): Part[] => {
  const [a, b] = [at(-3.25, 0), at(3.25, 0)];
  return [linkHalf(-1, 1.75), linkHalf(1, 1.75), line(`M${a[0]} ${a[1]} ${b[0]} ${b[1]}`)];
};

/** A link. */
export const LinkIcon = /* @__PURE__ */ glyph("Link", link);
