import { ArrowUpIcon, BellSlashIcon, CheckIcon, FolderPlusIcon } from "@ace/icons";
import { expect, test } from "vitest";
import { assetSvg, clippedSvg } from "./icon-svg.ts";

/** Every `clip-path` an element points at, and the clip each one names. */
function clipsOf(svg: string) {
  const used = [...svg.matchAll(/clip-path="url\(#([^)]+)\)"/g)].map((m) => m[1]);
  const defined = new Map(
    [...svg.matchAll(/<clipPath id="([^"]+)"><path clip-rule="evenodd" d="([^"]+)">/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );
  return { used, defined };
}

/** What an `<svg>` draws, inside its own element. */
const inner = (svg: string) => svg.slice(svg.indexOf(">") + 1, svg.lastIndexOf("</svg>"));

/** An icon whose one mask holds `cut`. */
const masked = (cut: string) =>
  `<svg><defs><mask id="m"><rect width="24" height="24" fill="white"></rect>${cut}</mask></defs><g mask="url(#m)"></g></svg>`;

type Point = readonly [number, number];
interface Cap {
  from: Point;
  to: Point;
  r: number;
  sweep: number;
}

/** A clip's cut-out band: its corners in order, and each cap's radius and sweep flag. */
function bandOf(clip: string) {
  const cut = clip.replace(/^M0 0H24V24H0Z/, "");
  const shape =
    /^M(\S+) (\S+)L(\S+) (\S+)A(\S+) (\S+) 0 0 (\d) (\S+) (\S+)L(\S+) (\S+)A(\S+) (\S+) 0 0 (\d) (\S+) (\S+)Z$/;
  const n = shape.exec(cut)?.slice(1).map(Number);
  if (!n) throw new Error(`Not a band: ${cut}`);
  const [ax, ay, bx, by, r1, , s1, cx, cy, dx, dy, r2, , s2, ex, ey] = n as number[];
  return {
    corners: [
      [ax, ay],
      [bx, by],
      [cx, cy],
      [dx, dy],
      [ex, ey],
    ] as [Point, Point, Point, Point, Point],
    caps: [
      { from: [bx, by], to: [cx, cy], r: r1, sweep: s1 },
      { from: [dx, dy], to: [ex, ey], r: r2, sweep: s2 },
    ] as [Cap, Cap],
  };
}

/** The point halfway round a half-circle cap, by SVG's arc rules: where the cap bulges to. */
function bulge(cap: Cap): Point {
  const [mx, my] = [(cap.from[0] + cap.to[0]) / 2, (cap.from[1] + cap.to[1]) / 2];
  const start = Math.atan2(cap.from[1] - my, cap.from[0] - mx);
  const mid = start + (cap.sweep === 1 ? Math.PI / 2 : -Math.PI / 2);
  return [mx + cap.r * Math.cos(mid), my + cap.r * Math.sin(mid)];
}

/** How far `p` sits from the line through `a` and `b`, positive on one side, negative on the other. */
const side = (p: Point, a: Point, b: Point) =>
  ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) /
  Math.hypot(b[0] - a[0], b[1] - a[1]);

test("an off icon's gap beside its slash is clipped out, with no mask left for iOS to rasterise", () => {
  const svg = assetSvg(BellSlashIcon, "regular");
  expect(svg).not.toContain("<mask");
  const { used, defined } = clipsOf(svg);
  expect(used.length).toBeGreaterThan(0);
  // The slash runs 3.75,3.75 to 20.25,20.25 at a 1.75 stroke. The gap is a 4.75-wide
  // round-capped band along 3,2.25 to 21.75,21: just above the slash, so it clears more of
  // the drawing on the upper right than on the lower left.
  const slash: Point[] = [
    [3.75, 3.75],
    [20.25, 20.25],
  ];
  const axis: [Point, Point] = [
    [3, 2.25],
    [21.75, 21],
  ];
  for (const id of used) {
    const { corners, caps } = bandOf(defined.get(id ?? "") ?? "");
    const expected = [
      [1.32, 3.93],
      [20.07, 22.68],
      [23.43, 19.32],
      [4.68, 0.57],
      [1.32, 3.93],
    ];
    for (const [i, [x, y]] of corners.entries()) {
      expect(x, `corner ${i} x`).toBeCloseTo(expected[i]?.[0] ?? NaN, 2);
      expect(y, `corner ${i} y`).toBeCloseTo(expected[i]?.[1] ?? NaN, 2);
    }
    // Each end is a half circle of the band's half width, bulging outward past the axis's end.
    for (const [i, cap] of caps.entries()) {
      expect(cap.r).toBeCloseTo(4.75 / 2, 1);
      const [x, y] = bulge(cap);
      const end = i === 0 ? axis[1] : axis[0];
      const away = i === 0 ? 1 : -1;
      expect(x, `cap ${i}`).toBeCloseTo(end[0] + away * 1.68, 1);
      expect(y, `cap ${i}`).toBeCloseTo(end[1] + away * 1.68, 1);
    }
    // The slash lies wholly inside the band, with clear space beyond its stroke on both sides.
    const [a, b, d, c] = corners;
    for (const point of slash) {
      const lowerLeft = side(point, a, b);
      const upperRight = side(point, c, d);
      expect(Math.abs(lowerLeft) - 1.75 / 2, "clear on the lower left").toBeGreaterThan(0.75);
      expect(Math.abs(upperRight) - 1.75 / 2, "clear on the upper right").toBeGreaterThan(1.5);
      expect(Math.abs(lowerLeft)).toBeLessThan(Math.abs(upperRight));
      expect(Math.sign(lowerLeft)).not.toBe(Math.sign(upperRight));
    }
  }
});

test("a new-item icon's hole under its plus is clipped out as a circle", () => {
  const { used, defined } = clipsOf(assetSvg(FolderPlusIcon, "regular"));
  expect(used.length).toBeGreaterThan(0);
  // Centred on the plus at 18, 18: from x 11.65 round to x 24.35.
  for (const id of used)
    expect(defined.get(id ?? "")).toContain("M11.65 18A6.35 6.35 0 1 0 24.35 18");
});

test("bold draws a heavier stroke than regular from the same drawing", () => {
  expect(assetSvg(CheckIcon, "regular")).toContain('stroke-width="1.75"');
  expect(assetSvg(CheckIcon, "bold")).toContain('stroke-width="2.25"');
});

test("a turned icon draws the set's drawing rotated about the box's centre", () => {
  const up = assetSvg(ArrowUpIcon, "regular");
  const down = assetSvg(ArrowUpIcon, "regular", 180);
  expect(inner(down)).toBe(`<g transform="rotate(180 12 12)">${inner(up)}</g>`);
});

test("a mask cut the iPhone can't clip stops the generator instead of drawing it wrong", () => {
  expect(() =>
    clippedSvg(masked('<rect x="1" y="1" width="4" height="4" fill="black"></rect>')),
  ).toThrow();
  expect(() =>
    clippedSvg(
      masked(
        '<circle cx="1" cy="1" r="1" fill="black"></circle><circle cx="5" cy="5" r="1" fill="black"></circle>',
      ),
    ),
  ).toThrow(/exactly one cut/);
});
