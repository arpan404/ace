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
  const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const out = new Float32Array(palette.length * 4);
  palette.forEach((name, index) => {
    if (!probe) return out.set([1, 1, 1, 1], index * 4);
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = style.getPropertyValue(token[name]).trim() || "#888";
    probe.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = probe.getImageData(0, 0, 1, 1).data;
    // Undo the canvas's premultiplication for translucent colours.
    const alpha = a / 255;
    out.set(
      alpha ? [r / 255 / alpha, g / 255 / alpha, b / 255 / alpha, alpha] : [0, 0, 0, 0],
      index * 4,
    );
  });
  return out;
}
