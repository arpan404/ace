/* Plane geometry the Fleet map's layout and its tests share. Pure. */

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const inflate = (box: Box, by: number): Box => ({
  x: box.x - by,
  y: box.y - by,
  width: box.width + by * 2,
  height: box.height + by * 2,
});

/** Whether the segment p→q passes through `box` (Liang–Barsky clipping). */
export function crosses(p: Point, q: Point, box: Box): boolean {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  let low = 0;
  let high = 1;
  const edges: [number, number][] = [
    [-dx, p.x - box.x],
    [dx, box.x + box.width - p.x],
    [-dy, p.y - box.y],
    [dy, box.y + box.height - p.y],
  ];
  for (const [step, room] of edges) {
    if (step === 0) {
      if (room < 0) return false;
      continue;
    }
    const t = room / step;
    if (step < 0) low = Math.max(low, t);
    else high = Math.min(high, t);
    if (low > high) return false;
  }
  return true;
}

/** How far `point` is from the segment p→q. */
export function distanceToSegment(point: Point, p: Point, q: Point): number {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const length = dx * dx + dy * dy;
  const t =
    length === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.x - p.x) * dx + (point.y - p.y) * dy) / length));
  return Math.hypot(point.x - (p.x + t * dx), point.y - (p.y + t * dy));
}

/** Whether two segments lie along each other for more than `tolerance` of their length. */
export function overlaps(a: [Point, Point], b: [Point, Point], tolerance = 0.5): boolean {
  const [p, q] = a;
  const [r, s] = b;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const length = Math.hypot(dx, dy);
  if (length === 0 || Math.hypot(s.x - r.x, s.y - r.y) === 0) return false;
  // Both ends of b must sit on a's line.
  const off = (point: Point) => Math.abs((point.x - p.x) * dy - (point.y - p.y) * dx) / length;
  if (off(r) > tolerance || off(s) > tolerance) return false;
  const along = (point: Point) => ((point.x - p.x) * dx + (point.y - p.y) * dy) / length;
  const start = Math.max(0, Math.min(along(r), along(s)));
  const end = Math.min(length, Math.max(along(r), along(s)));
  return end - start > tolerance;
}

/** A path's segments, in order. */
export const segmentsOf = (points: readonly Point[]): [Point, Point][] =>
  points.slice(1).flatMap((point, index) => {
    const previous = points[index];
    return previous ? [[previous, point] as [Point, Point]] : [];
  });
