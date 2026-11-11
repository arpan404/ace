/*
 * Reads a mark from a maker's own brand kit, kept byte-for-byte in this folder, into plain filled
 * outlines, so every renderer (web SVG, React Native, SwiftUI) draws it from the same path data.
 * Kits draw marks in many ways; this understands the few they use and refuses anything else:
 *
 * - `<g>` groups and their `transform` (translate, scale, matrix without rotation or skew), which
 *   are applied to the path data;
 * - presentation attributes, `style="…"` and a `<style>` sheet of tag and class rules;
 * - `<circle>`, turned into two arcs;
 * - strokes, turned into the filled outline they paint: a stroked circle is a ring, and a stroked
 *   path of lines and circular arcs that meet without corners is offset to both sides and closed
 *   with butt caps. This is exact geometry, not a redrawing.
 *
 * Metadata, titles and comments are skipped.
 */

export interface FlatPath {
  d: string;
  fill: string;
  fillRule?: "evenodd";
}

type Matrix = readonly [sx: number, sy: number, tx: number, ty: number];
const identity: Matrix = [1, 1, 0, 0];

interface Paint {
  fill: string;
  stroke: string;
  strokeWidth: number;
  fillRule: "evenodd" | "nonzero";
}

const attributes = (tag: string): Map<string, string> =>
  new Map(
    [...tag.matchAll(/([a-zA-Z][a-zA-Z0-9:-]*)="([^"]*)"/g)].map((m) => [m[1] ?? "", m[2] ?? ""]),
  );

const declarations = (text: string): Map<string, string> =>
  new Map(
    text
      .split(";")
      .map((part) => part.split(":").map((s) => s.trim()))
      .filter((pair): pair is [string, string] => pair.length === 2 && !!pair[0] && !!pair[1]),
  );

/** `<style>` rules by selector: a tag name or `.class`. Other selectors are ignored. */
function sheet(svg: string): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>();
  for (const style of svg.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) {
    for (const rule of (style[1] ?? "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const selector of (rule[1] ?? "").split(",").map((s) => s.trim())) {
        if (!/^\.?[a-zA-Z][\w-]*$/.test(selector)) continue;
        const own = rules.get(selector) ?? new Map<string, string>();
        for (const [name, value] of declarations(rule[2] ?? "")) own.set(name, value);
        rules.set(selector, own);
      }
    }
  }
  return rules;
}

/** A fill or stroke colour as a renderer takes it: CSS variable fallbacks resolved. */
function colour(value: string): string {
  const variable = /^var\(\s*--[\w-]+\s*,\s*(.+)\)$/.exec(value);
  const resolved = (variable?.[1] ?? value).trim();
  return resolved.toLowerCase() === "currentcolor" ? "currentColor" : resolved;
}

function transform(value: string | undefined, file: string): Matrix {
  let [sx, sy, tx, ty] = identity;
  for (const step of (value ?? "").matchAll(/(\w+)\(([^)]*)\)/g)) {
    const n = (step[2] ?? "")
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    let next: Matrix;
    if (step[1] === "translate") next = [1, 1, n[0] ?? 0, n[1] ?? 0];
    else if (step[1] === "scale") next = [n[0] ?? 1, n[1] ?? n[0] ?? 1, 0, 0];
    else if (step[1] === "matrix" && n[1] === 0 && n[2] === 0)
      next = [n[0] ?? 1, n[3] ?? 1, n[4] ?? 0, n[5] ?? 0];
    else throw new Error(`${file}: unsupported transform ${step[0]}`);
    // Each step applies inside the ones before it.
    tx += sx * next[2];
    ty += sy * next[3];
    sx *= next[0];
    sy *= next[1];
  }
  return [sx, sy, tx, ty];
}

const compose = (outer: Matrix, inner: Matrix): Matrix => [
  outer[0] * inner[0],
  outer[1] * inner[1],
  outer[0] * inner[2] + outer[2],
  outer[1] * inner[3] + outer[3],
];

type Command = { op: string; args: number[] };

const arity: Record<string, number> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
};

/** Path data as commands with absolute coordinates; arcs keep their flags. */
function absolute(d: string, file: string): Command[] {
  const commands: Command[] = [];
  let at = 0;
  const skip = () => {
    while (at < d.length && /[\s,]/.test(d[at] ?? "")) at++;
  };
  const number = (): number => {
    skip();
    const match = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(d.slice(at));
    if (!match) throw new Error(`${file}: bad path data near ${d.slice(at, at + 12)}`);
    at += match[0].length;
    return Number(match[0]);
  };
  const flag = (): number => {
    skip();
    const char = d[at++];
    if (char !== "0" && char !== "1") throw new Error(`${file}: bad arc flag`);
    return Number(char);
  };
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let op = "";
  for (skip(); at < d.length; skip()) {
    if (/[a-zA-Z]/.test(d[at] ?? "")) op = d[at++] ?? "";
    else if (!op || op === "z" || op === "Z") throw new Error(`${file}: bad path data`);
    const upper = op.toUpperCase();
    const count = arity[upper];
    if (count === undefined) throw new Error(`${file}: unsupported path command ${op}`);
    const relative = op !== upper;
    const raw: number[] = [];
    for (let i = 0; i < count; i++)
      raw.push(upper === "A" && (i === 3 || i === 4) ? flag() : number());
    const args = raw.map((value, i) => {
      if (!relative) return value;
      if (upper === "H") return value + x;
      if (upper === "V") return value + y;
      if (upper === "A") return i === 5 ? value + x : i === 6 ? value + y : value;
      return value + (i % 2 === 0 ? x : y);
    });
    if (upper === "Z") {
      commands.push({ op: "Z", args });
      [x, y] = [startX, startY];
      continue;
    }
    if (upper === "H") commands.push({ op: "L", args: [args[0] ?? 0, y] });
    else if (upper === "V") commands.push({ op: "L", args: [x, args[0] ?? 0] });
    else commands.push({ op: upper, args });
    const last = commands.at(-1)?.args ?? [];
    [x, y] = [last.at(-2) ?? x, last.at(-1) ?? y];
    if (upper === "M") {
      [startX, startY] = [x, y];
      // Pairs after a moveto are linetos.
      op = relative ? "l" : "L";
    }
  }
  return commands;
}

const round = (value: number) => String(Math.round(value * 1000) / 1000);

function serialise(commands: readonly Command[], m: Matrix): string {
  const flip = m[0] * m[1] < 0;
  return commands
    .map(({ op, args }) => {
      if (op === "Z") return "Z";
      const out =
        op === "A"
          ? [
              (args[0] ?? 0) * Math.abs(m[0]),
              (args[1] ?? 0) * Math.abs(m[1]),
              args[2] ?? 0,
              args[3] ?? 0,
              flip ? 1 - (args[4] ?? 0) : (args[4] ?? 0),
              (args[5] ?? 0) * m[0] + m[2],
              (args[6] ?? 0) * m[1] + m[3],
            ]
          : args.map((value, i) => (i % 2 === 0 ? value * m[0] + m[2] : value * m[1] + m[3]));
      return op + out.map(round).join(" ");
    })
    .join("");
}

const circlePath = (cx: number, cy: number, r: number): Command[] => [
  { op: "M", args: [cx - r, cy] },
  { op: "A", args: [r, r, 0, 1, 0, cx + r, cy] },
  { op: "A", args: [r, r, 0, 1, 0, cx - r, cy] },
  { op: "Z", args: [] },
];

type Point = readonly [number, number];
type Segment =
  | { kind: "line"; from: Point; to: Point }
  | { kind: "arc"; from: Point; to: Point; centre: Point; r: number; large: number; sweep: number };

const unit = (x: number, y: number): Point => {
  const length = Math.hypot(x, y);
  return [x / length, y / length];
};

/** The centre of a circular arc from its endpoints (SVG's endpoint parameterisation). */
function arcCentre(from: Point, to: Point, r: number, large: number, sweep: number): Point {
  const hx = (from[0] - to[0]) / 2;
  const hy = (from[1] - to[1]) / 2;
  const half = hx * hx + hy * hy;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (r * r - half) / half));
  return [k * hy + (from[0] + to[0]) / 2, -k * hx + (from[1] + to[1]) / 2];
}

/** Direction of travel at a point of a segment. */
function tangent(segment: Segment, at: Point): Point {
  if (segment.kind === "line")
    return unit(segment.to[0] - segment.from[0], segment.to[1] - segment.from[1]);
  const [dx, dy] = [at[0] - segment.centre[0], at[1] - segment.centre[1]];
  return segment.sweep ? unit(-dy, dx) : unit(dy, -dx);
}

function segments(commands: readonly Command[], file: string): Segment[] {
  const found: Segment[] = [];
  let at: Point = [0, 0];
  for (const { op, args } of commands) {
    const to: Point = [args.at(-2) ?? 0, args.at(-1) ?? 0];
    if (op === "M") {
      if (found.length) throw new Error(`${file}: a stroked path with several subpaths`);
    } else if (op === "L") found.push({ kind: "line", from: at, to });
    else if (op === "A" && args[0] === args[1]) {
      const [r = 0, , , large = 0, sweep = 0] = args;
      found.push({
        kind: "arc",
        from: at,
        to,
        r,
        large,
        sweep,
        centre: arcCentre(at, to, r, large, sweep),
      });
    } else throw new Error(`${file}: a stroke over ${op} can't be outlined`);
    at = to;
  }
  return found;
}

/** A point of a segment moved `offset` to the left of its direction of travel. */
function shifted(segment: Segment, p: Point, offset: number): Point {
  const [tx, ty] = tangent(segment, p);
  return [p[0] + ty * offset, p[1] - tx * offset];
}

/** One side of a stroke: each segment moved `offset` to its left. */
function side(path: readonly Segment[], offset: number): Command[] {
  return path.map((segment) => {
    const to = shifted(segment, segment.to, offset);
    if (segment.kind === "line") return { op: "L", args: [...to] };
    const r = Math.hypot(to[0] - segment.centre[0], to[1] - segment.centre[1]);
    return { op: "A", args: [r, r, 0, segment.large, segment.sweep, ...to] };
  });
}

const reversed = (path: readonly Segment[]): Segment[] =>
  path
    .map((segment): Segment =>
      segment.kind === "line"
        ? { ...segment, from: segment.to, to: segment.from }
        : { ...segment, from: segment.to, to: segment.from, sweep: 1 - segment.sweep },
    )
    .toReversed();

/** The filled outline a stroke of `width` paints along an open path, with butt caps. */
function outline(commands: readonly Command[], width: number, file: string): Command[] {
  const path = segments(commands, file);
  for (let i = 1; i < path.length; i++) {
    const [a, b] = [path[i - 1], path[i]];
    if (!a || !b) continue;
    const [ax, ay] = tangent(a, a.to);
    const [bx, by] = tangent(b, b.from);
    if (ax * bx + ay * by < 0.9999) throw new Error(`${file}: a stroke with corners`);
  }
  const first = path[0];
  const back = reversed(path);
  const end = back[0];
  if (!first || !end) throw new Error(`${file}: an empty stroked path`);
  const half = width / 2;
  // Up one side, across the far butt cap, back down the other; closing draws the near cap.
  return [
    { op: "M", args: [...shifted(first, first.from, half)] },
    ...side(path, half),
    { op: "L", args: [...shifted(end, end.from, half)] },
    ...side(back, half),
    { op: "Z", args: [] },
  ];
}

/** Every filled outline an official SVG paints, in paint order, with the fill it paints in. */
export function flatten(svg: string, file: string): { viewBox: string; paths: FlatPath[] } {
  const body = svg
    .replace(/<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/g, "")
    .replace(/<(metadata|title|desc|style)\b[\s\S]*?<\/\1>/g, "");
  const rules = sheet(svg);
  const root = /<svg\b[^>]*>/.exec(body);
  const viewBox = attributes(root?.[0] ?? "").get("viewBox");
  if (!viewBox) throw new Error(`${file}: no viewBox`);
  const initial: Paint = { fill: "black", stroke: "none", strokeWidth: 1, fillRule: "nonzero" };
  const stack: { paint: Paint; matrix: Matrix; tag: string }[] = [];
  let paint = initial;
  let matrix = identity;
  const paths: FlatPath[] = [];
  for (const match of body.matchAll(/<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, tag = "", rest = "", selfClosing] = match;
    if (closing) {
      const top = stack.pop();
      if (top?.tag !== tag) throw new Error(`${file}: unbalanced </${tag}>`);
      ({ paint, matrix } = stack.at(-1) ?? { paint: initial, matrix: identity });
      continue;
    }
    if (!["svg", "g", "path", "circle"].includes(tag))
      throw new Error(`${file}: unsupported element ${tag}`);
    const own = attributes(rest);
    const style = new Map<string, string>();
    const take = (from: Map<string, string> | undefined) => {
      for (const [name, value] of from ?? []) style.set(name, value);
    };
    take(own);
    take(rules.get(tag));
    for (const name of (own.get("class") ?? "").split(/\s+/)) if (name) take(rules.get(`.${name}`));
    take(declarations(own.get("style") ?? ""));
    const fillRule = style.get("fill-rule");
    const next: Paint = {
      fill: style.has("fill") ? colour(style.get("fill") ?? "") : paint.fill,
      stroke: style.has("stroke") ? colour(style.get("stroke") ?? "") : paint.stroke,
      strokeWidth: style.has("stroke-width")
        ? Number(style.get("stroke-width"))
        : paint.strokeWidth,
      fillRule: fillRule === "evenodd" || fillRule === "nonzero" ? fillRule : paint.fillRule,
    };
    const here = compose(matrix, transform(own.get("transform"), file));
    if (tag === "svg" || tag === "g") {
      if (!selfClosing) {
        stack.push({ paint: next, matrix: here, tag });
        [paint, matrix] = [next, here];
      }
      continue;
    }
    const shape = tag === "circle" ? undefined : absolute(own.get("d") ?? "", file);
    const [cx, cy, r] = ["cx", "cy", "r"].map((name) => Number(own.get(name) ?? 0));
    if (next.fill !== "none") {
      // Untransformed path data is kept exactly as the kit wrote it.
      const raw = own.get("d");
      const d =
        shape && raw && here.every((value, i) => value === identity[i])
          ? raw.replace(/\s+/g, " ").trim()
          : serialise(shape ?? circlePath(cx ?? 0, cy ?? 0, r ?? 0), here);
      paths.push({
        d,
        fill: next.fill,
        ...(next.fillRule === "evenodd" ? { fillRule: "evenodd" } : {}),
      });
    }
    if (next.stroke !== "none") {
      const half = next.strokeWidth / 2;
      const ring = shape
        ? outline(shape, next.strokeWidth, file)
        : [
            ...circlePath(cx ?? 0, cy ?? 0, (r ?? 0) + half),
            ...circlePath(cx ?? 0, cy ?? 0, (r ?? 0) - half),
          ];
      paths.push({
        d: serialise(ring, here),
        fill: next.stroke,
        ...(shape ? {} : { fillRule: "evenodd" }),
      });
    }
    if (!selfClosing) stack.push({ paint: next, matrix: here, tag });
  }
  if (stack.length) throw new Error(`${file}: unclosed elements`);
  return { viewBox, paths };
}
