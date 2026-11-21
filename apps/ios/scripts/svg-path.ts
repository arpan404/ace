/*
 * Pure SVG path (`d`) to Swift `Path` converter. Handles M/L/H/V/C/S/Q/A/Z (upper and lower
 * case) and converts elliptical arcs via W3C SVG 1.1 F.6.5/F.6.6 into cubic Bezier curves.
 */

export interface Point {
  x: number;
  y: number;
}

export const fmtNum = (value: number): string => {
  const rounded = Math.round(value * 10_000) / 10_000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

export const fmtPoint = (p: Point): string => `CGPoint(x: ${fmtNum(p.x)}, y: ${fmtNum(p.y)})`;

function angleBetween(ux: number, uy: number, vx: number, vy: number): number {
  const dot = ux * vx + uy * vy;
  const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  const ratio = Math.min(1, Math.max(-1, len === 0 ? 1 : dot / len));
  return (ux * vy - uy * vx < 0 ? -1 : 1) * Math.acos(ratio);
}

/** Converts an SVG elliptical arc (W3C SVG 1.1 F.6.5/F.6.6) into cubic Bezier curves. */
export function arcToCubics(
  from: Point,
  rxIn: number,
  ryIn: number,
  phiDeg: number,
  largeArc: boolean,
  sweep: boolean,
  to: Point,
): [Point, Point, Point][] {
  if (Math.hypot(to.x - from.x, to.y - from.y) < 1e-9) return [];
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx < 1e-9 || ry < 1e-9) return [[from, to, to]];

  const phi = (phiDeg * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx2 = (from.x - to.x) / 2;
  const dy2 = (from.y - to.y) / 2;
  const x1p = cosP * dx2 + sinP * dy2;
  const y1p = -sinP * dx2 + cosP * dy2;

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }

  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const x1p2 = x1p * x1p;
  const y1p2 = y1p * y1p;
  const num = Math.max(0, rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2);
  const den = rx2 * y1p2 + ry2 * x1p2;
  const sign = largeArc === sweep ? -1 : 1;
  const coef = den === 0 ? 0 : sign * Math.sqrt(num / den);
  const cxp = coef * ((rx * y1p) / ry);
  const cyp = coef * (-(ry * x1p) / rx);

  const cx = cosP * cxp - sinP * cyp + (from.x + to.x) / 2;
  const cy = sinP * cxp + cosP * cyp + (from.y + to.y) / 2;

  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta1 = angleBetween(1, 0, ux, uy);
  let delta = angleBetween(ux, uy, vx, vy);
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  if (sweep && delta < 0) delta += Math.PI * 2;

  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / segments;
  const alpha = (4 / 3) * Math.tan(step / 4);
  const mapPoint = (px: number, py: number): Point => ({
    x: cx + cosP * rx * px - sinP * ry * py,
    y: cy + sinP * rx * px + cosP * ry * py,
  });

  const curves: [Point, Point, Point][] = [];
  for (let i = 0; i < segments; i++) {
    const t1 = theta1 + i * step;
    const t2 = t1 + step;
    const c1 = Math.cos(t1);
    const s1 = Math.sin(t1);
    const c2 = Math.cos(t2);
    const s2 = Math.sin(t2);
    curves.push([
      mapPoint(c1 - alpha * s1, s1 + alpha * c1),
      mapPoint(c2 + alpha * s2, s2 - alpha * c2),
      mapPoint(c2, s2),
    ]);
  }
  return curves;
}

/** Swift statements appending SVG path `d` into `path`, with every coordinate absolute. */
export function svgPathToSwift(d: string): string[] {
  const tokens = d.match(/[MmLlHhVvCcSsQqAaZz]|-?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/g) ?? [];
  const lines: string[] = [];
  let at: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  let lastCubic: Point | null = null;
  let command = "";
  let index = 0;

  const next = () => {
    const token = tokens[index++];
    const value = Number(token);
    if (token === undefined || Number.isNaN(value)) throw new Error(`Bad path data: ${d}`);
    return value;
  };

  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (/[A-Za-z]/.test(token)) {
      command = token;
      index++;
    } else if (command === "M") command = "L";
    else if (command === "m") command = "l";

    const relative = command === command.toLowerCase();
    const base = relative ? at : { x: 0, y: 0 };
    const pair = (): Point => {
      const x = next();
      return { x: base.x + x, y: base.y + next() };
    };

    switch (command.toUpperCase()) {
      case "M":
        at = pair();
        start = at;
        lastCubic = null;
        lines.push(`path.move(to: ${fmtPoint(at)})`);
        break;
      case "L":
        at = pair();
        lastCubic = null;
        lines.push(`path.addLine(to: ${fmtPoint(at)})`);
        break;
      case "H":
        at = { x: (relative ? at.x : 0) + next(), y: at.y };
        lastCubic = null;
        lines.push(`path.addLine(to: ${fmtPoint(at)})`);
        break;
      case "V":
        at = { x: at.x, y: (relative ? at.y : 0) + next() };
        lastCubic = null;
        lines.push(`path.addLine(to: ${fmtPoint(at)})`);
        break;
      case "C": {
        const one = pair();
        const two = pair();
        at = pair();
        lastCubic = two;
        lines.push(
          `path.addCurve(to: ${fmtPoint(at)}, control1: ${fmtPoint(one)}, control2: ${fmtPoint(two)})`,
        );
        break;
      }
      case "S": {
        const one = lastCubic
          ? { x: 2 * at.x - lastCubic.x, y: 2 * at.y - lastCubic.y }
          : { ...at };
        const two = pair();
        at = pair();
        lastCubic = two;
        lines.push(
          `path.addCurve(to: ${fmtPoint(at)}, control1: ${fmtPoint(one)}, control2: ${fmtPoint(two)})`,
        );
        break;
      }
      case "Q": {
        const control = pair();
        at = pair();
        lastCubic = null;
        lines.push(`path.addQuadCurve(to: ${fmtPoint(at)}, control: ${fmtPoint(control)})`);
        break;
      }
      case "A": {
        const rx = next();
        const ry = next();
        const rotation = next();
        const largeArc = next() !== 0;
        const sweep = next() !== 0;
        const to = pair();
        for (const [c1, c2, end] of arcToCubics(at, rx, ry, rotation, largeArc, sweep, to)) {
          lines.push(
            `path.addCurve(to: ${fmtPoint(end)}, control1: ${fmtPoint(c1)}, control2: ${fmtPoint(c2)})`,
          );
        }
        at = to;
        lastCubic = null;
        break;
      }
      case "Z":
        lines.push("path.closeSubpath()");
        at = start;
        lastCubic = null;
        break;
      default:
        throw new Error(`Unsupported path command ${command} in ${d}`);
    }
  }
  return lines;
}
