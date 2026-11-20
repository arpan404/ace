import { faceInk, facePaper } from "@ace/ui-core/bot-face";
import { fmtNum, fmtPoint, svgPathToSwift } from "./svg-path.ts";

export { arcToCubics, fmtNum, fmtPoint, svgPathToSwift, type Point } from "./svg-path.ts";

/*
 * Converts the small subset of SVG geometry ui-core's bot-face emits (`<path>`, `<circle>`,
 * `<ellipse>`, `<rect>`, `<line>`, `<g>` with `rotate`, `clip-path`, fill and stroke) into
 * Swift `Path` instructions and typed drawing pieces on the 24×24 box.
 */

export type SwiftTone =
  | "body"
  | "accent"
  | "bodyShade"
  | "accentShade"
  | "pale"
  | "visor"
  | "mask"
  | "blush"
  | "tongue"
  | "ink"
  | "paper"
  | "sweat";

export interface SwiftRotation {
  degrees: number;
  cx: number;
  cy: number;
}

export interface SwiftStroke {
  tone: SwiftTone;
  width: number;
  opacity: number;
  roundCap: boolean;
  roundJoin: boolean;
}

export interface SwiftPiece {
  /** Swift statements appending this shape's geometry to `path`. */
  pathLines: string[];
  fill: SwiftTone | null;
  fillOpacity: number;
  stroke: SwiftStroke | null;
  clipped: boolean;
  rotation: SwiftRotation | null;
}

const cssVarTone: Record<string, SwiftTone> = {
  "var(--b)": "body",
  "var(--a)": "accent",
  "var(--bs)": "bodyShade",
  "var(--as)": "accentShade",
  "var(--bl)": "pale",
  "var(--visor)": "visor",
  "var(--mask)": "mask",
  "var(--blush)": "blush",
  "var(--tongue)": "tongue",
};

function parseTone(raw: string | undefined): SwiftTone | null {
  if (!raw || raw === "none") return null;
  const known = cssVarTone[raw];
  if (known) return known;
  const lower = raw.toLowerCase();
  if (lower === faceInk.toLowerCase()) return "ink";
  if (lower === facePaper.toLowerCase()) return "paper";
  if (lower === "#cfe6ff") return "sweat";
  throw new Error(`Unsupported SVG colour in bot face: ${raw}`);
}

function parseRotation(transform: string | undefined): SwiftRotation | null {
  if (!transform) return null;
  const match = /^rotate\(\s*([^\s,]+)(?:[\s,]+([^\s,]+)[\s,]+([^\s,]+))?\s*\)$/.exec(
    transform.trim(),
  );
  if (!match) throw new Error(`Unsupported SVG transform in bot face: ${transform}`);
  return {
    degrees: Number(match[1]),
    cx: match[2] === undefined ? 0 : Number(match[2]),
    cy: match[3] === undefined ? 0 : Number(match[3]),
  };
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(/([a-zA-Z0-9_-]+)="([^"]*)"/g)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) attrs[key] = value;
  }
  return attrs;
}

function shapePathLines(tag: string, attrs: Record<string, string>): string[] {
  const num = (name: string, fallback = 0) =>
    attrs[name] === undefined ? fallback : Number(attrs[name]);
  switch (tag) {
    case "path":
      return svgPathToSwift(attrs["d"] ?? "");
    case "circle": {
      const cx = num("cx");
      const cy = num("cy");
      const r = num("r");
      return [
        `path.addEllipse(in: CGRect(x: ${fmtNum(cx - r)}, y: ${fmtNum(cy - r)}, width: ${fmtNum(r * 2)}, height: ${fmtNum(r * 2)}))`,
      ];
    }
    case "ellipse": {
      const cx = num("cx");
      const cy = num("cy");
      const rx = num("rx");
      const ry = num("ry");
      return [
        `path.addEllipse(in: CGRect(x: ${fmtNum(cx - rx)}, y: ${fmtNum(cy - ry)}, width: ${fmtNum(rx * 2)}, height: ${fmtNum(ry * 2)}))`,
      ];
    }
    case "rect": {
      const x = num("x");
      const y = num("y");
      const w = num("width");
      const h = num("height");
      const rx = num("rx");
      const ry = num("ry", rx);
      const rect = `CGRect(x: ${fmtNum(x)}, y: ${fmtNum(y)}, width: ${fmtNum(w)}, height: ${fmtNum(h)})`;
      if (rx === 0 && ry === 0) return [`path.addRect(${rect})`];
      return [
        `path.addRoundedRect(in: ${rect}, cornerSize: CGSize(width: ${fmtNum(rx)}, height: ${fmtNum(ry)}))`,
      ];
    }
    case "line":
      return [
        `path.move(to: ${fmtPoint({ x: num("x1"), y: num("y1") })})`,
        `path.addLine(to: ${fmtPoint({ x: num("x2"), y: num("y2") })})`,
      ];
    default:
      throw new Error(`Unsupported SVG element <${tag}> in bot face`);
  }
}

/** Extracts pure silhouette geometry (all shapes merged into one Swift `Path`). */
export function svgShapesToSwiftPath(markup: string): string[] {
  const lines: string[] = [];
  for (const match of markup.matchAll(/<(path|circle|ellipse|rect|line)\b([^>]*?)\/>/g)) {
    const tag = match[1];
    const attrs = parseAttrs(match[2] ?? "");
    if (tag) lines.push(...shapePathLines(tag, attrs));
  }
  return lines;
}

interface GroupContext {
  fill: string | undefined;
  stroke: string | undefined;
  strokeWidth: number;
  strokeOpacity: number;
  strokeLinecap: string | undefined;
  strokeLinejoin: string | undefined;
  opacity: number;
  clipped: boolean;
}

const emptyGroup: GroupContext = {
  fill: undefined,
  stroke: undefined,
  strokeWidth: 1,
  strokeOpacity: 1,
  strokeLinecap: undefined,
  strokeLinejoin: undefined,
  opacity: 1,
  clipped: false,
};

function mergeGroup(parent: GroupContext, attrs: Record<string, string>): GroupContext {
  const opacity = attrs["opacity"] === undefined ? 1 : Number(attrs["opacity"]);
  return {
    fill: attrs["fill"] ?? parent.fill,
    stroke: attrs["stroke"] ?? parent.stroke,
    strokeWidth:
      attrs["stroke-width"] === undefined ? parent.strokeWidth : Number(attrs["stroke-width"]),
    strokeOpacity:
      attrs["stroke-opacity"] === undefined
        ? parent.strokeOpacity
        : Number(attrs["stroke-opacity"]),
    strokeLinecap: attrs["stroke-linecap"] ?? parent.strokeLinecap,
    strokeLinejoin: attrs["stroke-linejoin"] ?? parent.strokeLinejoin,
    opacity: parent.opacity * opacity,
    clipped: parent.clipped || attrs["clip-path"] !== undefined,
  };
}

/** Parses an SVG markup fragment from ui-core's bot-face into ordered Swift drawing pieces. */
export function svgFragmentToPieces(markup: string): SwiftPiece[] {
  const pieces: SwiftPiece[] = [];
  const stack: GroupContext[] = [emptyGroup];
  const tagPattern = /<\/g>|<([a-zA-Z]+)\b([^>]*?)(\/?)>/g;

  for (const match of markup.matchAll(tagPattern)) {
    if (match[0] === "</g>") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const tag = match[1] ?? "";
    const attrs = parseAttrs(match[2] ?? "");
    const selfClosing = match[3] === "/";
    const current = stack[stack.length - 1] ?? emptyGroup;
    if (tag === "g") {
      if (!selfClosing) stack.push(mergeGroup(current, attrs));
      continue;
    }
    const style = mergeGroup(current, attrs);
    const fill = parseTone(style.fill);
    const strokeTone = parseTone(style.stroke);
    const fillOpacity =
      style.opacity * (attrs["fill-opacity"] === undefined ? 1 : Number(attrs["fill-opacity"]));
    pieces.push({
      pathLines: shapePathLines(tag, attrs),
      fill,
      fillOpacity,
      stroke: strokeTone
        ? {
            tone: strokeTone,
            width: style.strokeWidth,
            opacity: style.opacity * style.strokeOpacity,
            roundCap: style.strokeLinecap === "round",
            roundJoin: style.strokeLinejoin === "round",
          }
        : null,
      clipped: style.clipped,
      rotation: parseRotation(attrs["transform"]),
    });
  }
  return pieces;
}
