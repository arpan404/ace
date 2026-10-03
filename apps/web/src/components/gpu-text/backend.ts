import { rgba } from "@/lib/css-color.ts";
import { palette, type Frame } from "./layout.ts";

/** A GPU backend draws a laid-out frame of glyph quads from the atlas. */
export interface TextBackend {
  readonly kind: "webgpu" | "webgl2";
  draw(frame: Frame, size: { width: number; height: number; scale: number }): void;
  /** Theme colours, RGBA 0..1, in `palette` order. */
  colors(rgba: Float32Array): void;
  dispose(): void;
}

/** Colours of the palette from the theme tokens on `element`, as RGBA 0..1. */
export function themeColors(element: Element): Float32Array {
  const style = getComputedStyle(element);
  const token: Record<(typeof palette)[number], string> = {
    plain: "--foreground",
    muted: "--subtle-foreground",
    add: "--foreground",
    del: "--foreground",
    addBand: "--diff-add",
    delBand: "--diff-del",
    foldBand: "--muted",
  };
  const out = new Float32Array(palette.length * 4);
  palette.forEach((name, index) => {
    const [r, g, b, a] = rgba(style.getPropertyValue(token[name]).trim() || "#888");
    out.set([r / 255, g / 255, b / 255, a / 255], index * 4);
  });
  return out;
}
