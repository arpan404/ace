/**
 * Geometry for ace's icons, on a 24×24 box. Pure functions that return SVG path data, so a
 * glyph is a few calls and every icon rounds its corners the same way.
 */

/** A vertex, with the radius its corner is rounded to (0 or absent: the stroke's round join). */
export type Vertex = readonly [x: number, y: number, radius?: number];
export type Point = readonly [x: number, y: number];

const fixed = (n: number): string => {
  const text = n.toFixed(2);
  return text.replace(/\.?0+$/, "") || "0";
};
const at = (x: number, y: number): string => `${fixed(x)} ${fixed(y)}`;

/** How far along each edge a corner's curve starts, as a share of its radius. */
const reach = 1.15;
/** Where the curve's handles sit between its ends and the vertex: a little past a circle's 0.55, for a softer corner. */
const handle = 0.6;

interface Corner {
  start: Point;
  end: Point;
  c1: Point;
  c2: Point;
}

function corner(v: Vertex, before: Vertex, after: Vertex): Corner {
  const r = (v[2] ?? 0) * reach;
  const toward = (o: Vertex): Point => {
    const dx = o[0] - v[0];
    const dy = o[1] - v[1];
    const length = Math.hypot(dx, dy) || 1;
    const t = Math.min(r, length / 2.01) / length;
    return [v[0] + dx * t, v[1] + dy * t];
  };
  const start = toward(before);
  const end = toward(after);
  const pull = (p: Point): Point => [p[0] + (v[0] - p[0]) * handle, p[1] + (v[1] - p[1]) * handle];
  return { start, end, c1: pull(start), c2: pull(end) };
}

/** The vertex at `i`, wrapping around the ends. */
const picker =
  (points: readonly Vertex[]) =>
  (i: number): Vertex =>
    points[(i + points.length) % points.length] ?? [0, 0];

const curve = (c: Corner): string =>
  `L${at(...c.start)}C${at(...c.c1)} ${at(...c.c2)} ${at(...c.end)}`;

/** An open line through `points`, each inner corner rounded to its own radius. */
export function polyline(points: readonly Vertex[]): string {
  const n = points.length;
  if (n < 2) return "";
  const pick = picker(points);
  let d = `M${at(pick(0)[0], pick(0)[1])}`;
  for (let i = 1; i < n - 1; i++) d += curve(corner(pick(i), pick(i - 1), pick(i + 1)));
  return `${d}L${at(pick(n - 1)[0], pick(n - 1)[1])}`;
}

/** A closed shape through `points`, every corner rounded to its own radius. */
export function polygon(points: readonly Vertex[]): string {
  const n = points.length;
  if (n < 3) return "";
  const pick = picker(points);
  const corners = points.map((v, i) => corner(v, pick(i - 1), pick(i + 1)));
  const [first] = corners;
  if (!first) return "";
  let d = `M${at(...first.end)}`;
  for (const c of [...corners.slice(1), first]) d += curve(c);
  return `${d}Z`;
}

/** A rectangle with every corner rounded to `radius`. */
export function rect(x: number, y: number, width: number, height: number, radius: number): string {
  return polygon([
    [x, y, radius],
    [x + width, y, radius],
    [x + width, y + height, radius],
    [x, y + height, radius],
  ]);
}

/** The point at `degrees` on a circle (0° points right, 90° down). */
export function onCircle(cx: number, cy: number, r: number, degrees: number): Point {
  const a = (degrees * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** An arc of a circle from `from` to `to` degrees, clockwise when `to` is larger. */
export function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  const p0 = onCircle(cx, cy, r, from);
  const p1 = onCircle(cx, cy, r, to);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  const sweep = to > from ? 1 : 0;
  return `M${at(...p0)}A${fixed(r)} ${fixed(r)} 0 ${large} ${sweep} ${at(...p1)}`;
}

/** An arrowhead whose tip is at `tip`, pointing toward `degrees`, with arms `length` long. */
export function arrowhead(tip: Point, degrees: number, length: number): string {
  const a = (degrees * Math.PI) / 180;
  const arm = (turn: number): Vertex => [
    tip[0] + length * Math.cos(a + turn),
    tip[1] + length * Math.sin(a + turn),
  ];
  return polyline([arm(Math.PI * 0.75), [tip[0], tip[1], 0.6], arm(-Math.PI * 0.75)]);
}

/** An ellipse turned by `degrees`, as a closed path. */
export function ellipse(cx: number, cy: number, rx: number, ry: number, degrees = 0): string {
  const a = (degrees * Math.PI) / 180;
  const dx = rx * Math.cos(a);
  const dy = rx * Math.sin(a);
  const r = `${fixed(rx)} ${fixed(ry)} ${fixed(degrees)}`;
  return `M${at(cx + dx, cy + dy)}A${r} 1 1 ${at(cx - dx, cy - dy)}A${r} 1 1 ${at(cx + dx, cy + dy)}Z`;
}

/** A four-pointed star with curved sides, `r` from centre to tip; `pinch` sets how thin its waist is. */
export function sparkle(cx: number, cy: number, r: number, pinch = 0.17): string {
  const q = r * pinch;
  const side = (x1: number, y1: number, x2: number, y2: number) =>
    `C${at(cx + x1 * q, cy + y1 * q)} ${at(cx + x1 * q, cy + y1 * q)} ${at(x2, y2)}`;
  return (
    `M${at(cx, cy - r)}` +
    side(1, -1, cx + r, cy) +
    side(1, 1, cx, cy + r) +
    side(-1, 1, cx - r, cy) +
    side(-1, -1, cx, cy - r) +
    "Z"
  );
}

/**
 * A round speech bubble: a circle with a short rounded tail at its lower left, or its lower
 * right when `mirrored`.
 */
export function bubble(cx: number, cy: number, r: number, mirrored = false): string {
  const side = mirrored ? 1 : -1;
  const a = onCircle(cx, cy, r, mirrored ? 22 : 112);
  const b = onCircle(cx, cy, r, mirrored ? 68 : 158);
  const tip: Point = [cx + side * r * 1.06, cy + r * 1.06];
  const near = (p: Point): Point => {
    const dx = p[0] - tip[0];
    const dy = p[1] - tip[1];
    const length = Math.hypot(dx, dy);
    return [tip[0] + (dx / length) * 1.2, tip[1] + (dy / length) * 1.2];
  };
  const radius = `${fixed(r)} ${fixed(r)} 0`;
  const top = at(cx, cy - r);
  const tail = `L${at(...near(a))}Q${at(...tip)} ${at(...near(b))}L${at(...b)}`;
  return mirrored
    ? `M${top}A${radius} 0 1 ${at(...a)}${tail}A${radius} 1 1 ${top}Z`
    : `M${top}A${radius} 1 1 ${at(...a)}${tail}A${radius} 0 1 ${top}Z`;
}

/** `points` turned by `degrees` (clockwise) about `cx`, `cy`, radii kept: for drawing a tilted shape upright. */
export function turned(points: readonly Vertex[], degrees: number, cx = 12, cy = 12): Vertex[] {
  const a = (degrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return points.map(([x, y, r = 0]): Vertex => {
    const dx = x - cx;
    const dy = y - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos, r];
  });
}

/** `points` grown by `factor` about `cx`, `cy`, radii kept. */
export function scaled(points: readonly Vertex[], factor: number, cx = 12, cy = 12): Vertex[] {
  return points.map(([x, y, r = 0]): Vertex => [cx + (x - cx) * factor, cy + (y - cy) * factor, r]);
}
