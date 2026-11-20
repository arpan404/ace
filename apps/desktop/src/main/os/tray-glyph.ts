import { agentCursorPath } from "@ace/design-tokens/glyphs";
import { glyphCommands, type GlyphPoint } from "@ace/design-tokens/glyph-path";

/** Raw pixels as Electron's `toBitmap` gives them: 4 bytes a pixel, alpha last. */
export interface Bitmap {
  width: number;
  height: number;
  data: Buffer;
}

/** The pointer's height against the icon's, and the space between them. */
const pointerShare = 0.64;
const gapShare = 0.14;
/** Samples a pixel's side is split into, for smooth edges. */
const samples = 4;

/** The agent pointer's outline in its 24 box, its curves flattened to short lines. */
function pointerOutline(): GlyphPoint[] {
  const points: GlyphPoint[] = [];
  let at: GlyphPoint = { x: 0, y: 0 };
  for (const step of glyphCommands(agentCursorPath)) {
    if (step.kind === "close") continue;
    if (step.kind !== "curve") {
      at = step.to;
      points.push(at);
      continue;
    }
    const { control1: b, control2: c, to: d } = step;
    const a = at;
    for (let i = 1; i <= 12; i++) {
      const t = i / 12;
      const u = 1 - t;
      points.push({
        x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
        y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
      });
    }
    at = d;
  }
  return points;
}

function inside(points: readonly GlyphPoint[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const p = points[i];
    const q = points[j];
    if (!p || !q) continue;
    if (p.y > y !== q.y > y && x < ((q.x - p.x) * (y - p.y)) / (q.y - p.y) + p.x) hit = !hit;
  }
  return hit;
}

/**
 * The menu-bar icon while an agent uses an app: the icon, then ace's agent pointer
 * (`agentCursorPath`, the mark thread rows show) beside it, centred on its height. Drawn in
 * black with the edge's coverage as alpha, so a template image tints it as it tints the icon.
 */
export function withAgentPointer(icon: Bitmap): Bitmap {
  const outline = pointerOutline();
  const xs = outline.map((point) => point.x);
  const ys = outline.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const tall = Math.round(icon.height * pointerShare);
  const scale = tall / (Math.max(...ys) - top);
  const wide = Math.ceil((Math.max(...xs) - left) * scale);
  const gap = Math.round(icon.height * gapShare);
  const width = icon.width + gap + wide;
  const data = Buffer.alloc(width * icon.height * 4);
  for (let row = 0; row < icon.height; row++)
    icon.data.copy(data, row * width * 4, row * icon.width * 4, (row + 1) * icon.width * 4);
  const offsetY = Math.floor((icon.height - tall) / 2);
  const offsetX = icon.width + gap;
  for (let y = 0; y < tall; y++)
    for (let x = 0; x < wide; x++) {
      let covered = 0;
      for (let sy = 0; sy < samples; sy++)
        for (let sx = 0; sx < samples; sx++) {
          const gx = left + (x + (sx + 0.5) / samples) / scale;
          const gy = top + (y + (sy + 0.5) / samples) / scale;
          if (inside(outline, gx, gy)) covered++;
        }
      if (!covered) continue;
      const at = ((offsetY + y) * width + offsetX + x) * 4;
      data[at + 3] = Math.round((covered / (samples * samples)) * 255);
    }
  return { width, height: icon.height, data };
}
