/*
 * SVG path data reduced to absolute M, L, C, Q and Z, so the native app can draw a mark with a
 * five-command reader. Relative commands become absolute, H and V become lines, S and T get
 * their reflected control points, and each arc becomes cubic segments of at most a quarter turn.
 */

type Point = [number, number];

class Scanner {
  #text: string;
  #at = 0;
  constructor(text: string) {
    this.#text = text;
  }
  #skip(): void {
    while (this.#at < this.#text.length && /[\s,]/.test(this.#text.charAt(this.#at))) this.#at++;
  }
  command(): string | undefined {
    this.#skip();
    const char = this.#text.charAt(this.#at);
    if (/[a-zA-Z]/.test(char)) {
      this.#at++;
      return char;
    }
    return undefined;
  }
  number(): number {
    this.#skip();
    const match = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(this.#text.slice(this.#at));
    if (!match) throw new Error(`Expected a number at ${this.#at} in path data`);
    this.#at += match[0].length;
    return Number(match[0]);
  }
  /** Arc flags may be written without separators ("01"). */
  flag(): boolean {
    this.#skip();
    const char = this.#text.charAt(this.#at);
    if (char !== "0" && char !== "1") throw new Error(`Expected an arc flag at ${this.#at}`);
    this.#at++;
    return char === "1";
  }
  done(): boolean {
    this.#skip();
    return this.#at >= this.#text.length;
  }
}

const round = (value: number) => Number(value.toFixed(3));
const format = (command: string, points: Point[]) =>
  [command, ...points.flatMap(([x, y]) => [round(x), round(y)])].join(" ");

/** The signed angle from one vector to another. */
const angle = (ux: number, uy: number, vx: number, vy: number) =>
  Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);

/** The arc from `from` to `to` as cubic Béziers (SVG 1.1 implementation notes, F.6.5). */
function arcToCubics(
  from: Point,
  radii: Point,
  rotation: number,
  large: boolean,
  sweep: boolean,
  to: Point,
): Point[][] {
  let [rx, ry] = [Math.abs(radii[0]), Math.abs(radii[1])];
  if (rx === 0 || ry === 0 || (from[0] === to[0] && from[1] === to[1])) return [[from, to, to]];
  const phi = (rotation * Math.PI) / 180;
  const [cos, sin] = [Math.cos(phi), Math.sin(phi)];
  const dx = (from[0] - to[0]) / 2;
  const dy = (from[1] - to[1]) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator));
  const cx1 = (factor * rx * y1) / ry;
  const cy1 = (-factor * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (from[0] + to[0]) / 2;
  const cy = sin * cx1 + cos * cy1 + (from[1] + to[1]) / 2;
  const start = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / segments;
  const k = (4 / 3) * Math.tan(step / 4);
  const at = (theta: number): Point => [
    cx + rx * Math.cos(theta) * cos - ry * Math.sin(theta) * sin,
    cy + rx * Math.cos(theta) * sin + ry * Math.sin(theta) * cos,
  ];
  const tangent = (theta: number): Point => [
    -rx * Math.sin(theta) * cos - ry * Math.cos(theta) * sin,
    -rx * Math.sin(theta) * sin + ry * Math.cos(theta) * cos,
  ];
  const curves: Point[][] = [];
  for (let index = 0; index < segments; index++) {
    const a = start + index * step;
    const b = a + step;
    const [p0, p3] = [at(a), at(b)];
    const [t0, t1] = [tangent(a), tangent(b)];
    curves.push([
      [p0[0] + k * t0[0], p0[1] + k * t0[1]],
      [p3[0] - k * t1[0], p3[1] - k * t1[1]],
      index === segments - 1 ? to : p3,
    ]);
  }
  return curves;
}

/** `d` as absolute M, L, C, Q and Z commands separated by spaces. */
export function normalisePath(d: string): string {
  const scanner = new Scanner(d);
  const out: string[] = [];
  let current: Point = [0, 0];
  let start: Point = [0, 0];
  let lastCubic: Point | undefined;
  let lastQuad: Point | undefined;
  let command = "";
  while (!scanner.done()) {
    const next = scanner.command();
    if (next) command = next;
    else if (!command) throw new Error("Path data must start with a command");
    const relative = command === command.toLowerCase();
    const point = (): Point => {
      const x = scanner.number();
      const y = scanner.number();
      return relative ? [current[0] + x, current[1] + y] : [x, y];
    };
    const upper = command.toUpperCase();
    let cubic: Point | undefined;
    let quad: Point | undefined;
    switch (upper) {
      case "M": {
        current = point();
        start = current;
        out.push(format("M", [current]));
        // Further pairs after a move are lines.
        command = relative ? "l" : "L";
        break;
      }
      case "L":
        current = point();
        out.push(format("L", [current]));
        break;
      case "H": {
        const x = scanner.number();
        current = [relative ? current[0] + x : x, current[1]];
        out.push(format("L", [current]));
        break;
      }
      case "V": {
        const y = scanner.number();
        current = [current[0], relative ? current[1] + y : y];
        out.push(format("L", [current]));
        break;
      }
      case "C": {
        const c1 = point();
        const c2 = point();
        const end = point();
        out.push(format("C", [c1, c2, end]));
        cubic = c2;
        current = end;
        break;
      }
      case "S": {
        const c1: Point = lastCubic
          ? [2 * current[0] - lastCubic[0], 2 * current[1] - lastCubic[1]]
          : current;
        const c2 = point();
        const end = point();
        out.push(format("C", [c1, c2, end]));
        cubic = c2;
        current = end;
        break;
      }
      case "Q": {
        const c = point();
        const end = point();
        out.push(format("Q", [c, end]));
        quad = c;
        current = end;
        break;
      }
      case "T": {
        const c: Point = lastQuad
          ? [2 * current[0] - lastQuad[0], 2 * current[1] - lastQuad[1]]
          : current;
        const end = point();
        out.push(format("Q", [c, end]));
        quad = c;
        current = end;
        break;
      }
      case "A": {
        const radii: Point = [scanner.number(), scanner.number()];
        const rotation = scanner.number();
        const large = scanner.flag();
        const sweep = scanner.flag();
        const end = point();
        for (const curve of arcToCubics(current, radii, rotation, large, sweep, end))
          out.push(format("C", curve));
        current = end;
        break;
      }
      case "Z":
        out.push("Z");
        current = start;
        // Z takes no numbers; a following number would repeat the previous command, which SVG forbids.
        command = "";
        break;
      default:
        throw new Error(`Unsupported path command ${command}`);
    }
    lastCubic = cubic;
    lastQuad = quad;
  }
  return out.join(" ");
}
