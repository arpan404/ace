/*
 * ace's mark set in type: the mark's outline is laid over a grid of character cells, and each
 * cell the mark covers takes a letter of the word. Pure: a path and a size in, rows of text out
 * (components/site/Backdrop.astro prints them behind every page).
 */

export interface Point {
  x: number;
  y: number;
}

const curveSteps = 12;

/**
 * One closed outline from an SVG path that uses absolute M, L, H, V, C and Z, the commands the
 * mark is drawn with. Curves become short straight runs.
 */
export function outline(path: string): Point[] {
  const points: Point[] = [];
  let at: Point = { x: 0, y: 0 };
  for (const [, command, rest = ""] of path.matchAll(/([MLHVCZ])([^MLHVCZ]*)/g)) {
    const n = (rest.match(/-?\d*\.?\d+/g) ?? []).map(Number);
    const value = (index: number) => n[index] ?? 0;
    if (command === "M" || command === "L") {
      for (let i = 0; i + 1 < n.length; i += 2)
        points.push((at = { x: value(i), y: value(i + 1) }));
    } else if (command === "H") {
      points.push((at = { x: value(0), y: at.y }));
    } else if (command === "V") {
      points.push((at = { x: at.x, y: value(0) }));
    } else if (command === "C") {
      for (let i = 0; i + 5 < n.length; i += 6) {
        const from = at;
        for (let step = 1; step <= curveSteps; step++) {
          const t = step / curveSteps;
          const u = 1 - t;
          const mix = (a: number, b: number, c: number, d: number) =>
            u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
          points.push({
            x: mix(from.x, value(i), value(i + 2), value(i + 4)),
            y: mix(from.y, value(i + 1), value(i + 3), value(i + 5)),
          });
        }
        at = { x: value(i + 4), y: value(i + 5) };
      }
    }
  }
  return points;
}

/** Whether a point lies inside a closed outline. */
export function inside(shape: Point[], x: number, y: number): boolean {
  let within = false;
  for (let i = 0, j = shape.length - 1; i < shape.length; j = i++) {
    const a = shape[i];
    const b = shape[j];
    if (!a || !b) continue;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) within = !within;
  }
  return within;
}

export interface MarkGrid {
  /** One wing's path; the mark is the wing and its mirror image. */
  wing: string;
  /** The width of the box the wing is drawn in; the mirror line is its middle. */
  box: number;
  /** Characters across. */
  columns: number;
  /** A character cell's width over its height, as the type is set. */
  cell: number;
  /** The word the mark is written in. */
  word: string;
}

/**
 * The mark as rows of text, trimmed to the mark's own edges. A cell is a letter when the mark
 * covers at least half of it and a space otherwise; each row starts the word one letter later
 * than the row above, so the letters run in diagonals rather than columns.
 */
export function markRows({ wing, box, columns, cell, word }: MarkGrid): string[] {
  const left = outline(wing);
  const xs = left.flatMap((point) => [point.x, box - point.x]);
  const ys = left.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const size = (Math.max(...xs) - minX) / columns;
  const height = size / cell;
  const rows = Math.round((Math.max(...ys) - minY) / height);
  const samples = [0.2, 0.5, 0.8];
  const covered = (x: number, y: number) => inside(left, x, y) || inside(left, box - x, y);

  return Array.from({ length: rows }, (_, row) => {
    let line = "";
    for (let column = 0; column < columns; column++) {
      let hits = 0;
      for (const sx of samples) {
        for (const sy of samples) {
          if (covered(minX + (column + sx) * size, minY + (row + sy) * height)) hits++;
        }
      }
      line += hits * 2 >= samples.length ** 2 ? word[(column + row) % word.length] : " ";
    }
    return line.trimEnd();
  });
}
