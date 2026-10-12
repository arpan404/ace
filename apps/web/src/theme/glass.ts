/*
 * Liquid glass for floating layers (docs/design/visual-language.md, "Glass"): the pure half.
 * Chromium, Electron included, renders an SVG filter through `backdrop-filter: url()`, so floating
 * layers there bend what's behind them at the rim. Safari and Firefox drop that silently while
 * `CSS.supports` still says yes, so the engine is read from the user agent and they get blur and
 * saturate instead. The DOM shell that measures layers and keeps their filters is liquid-glass.ts.
 */

export type GlassEngine = "liquid" | "blur";

interface Brand {
  brand: string;
}

/** "liquid" only where SVG backdrop filters render: Chromium on desktop and Android. */
export function glassEngine(userAgent: string, brands: readonly Brand[] = []): GlassEngine {
  // Every iOS browser is WebKit underneath, whatever its name says.
  if (/iPhone|iPad|iPod|CriOS|FxiOS|EdgiOS|OPiOS/.test(userAgent)) return "blur";
  if (brands.some((entry) => /Chromium/i.test(entry.brand))) return "liquid";
  return /Chrome\/\d+/.test(userAgent) && !/Firefox\//.test(userAgent) ? "liquid" : "blur";
}

/** The rim that bends: at most 24px deep, less on a layer too small to hold it. */
const maxBand = 24;
/** How far the backdrop moves at the very edge, in px. */
const maxBend = 24;
/** Sizes round to this step, so layers that differ by a pixel or two share one filter. */
const sizeStep = 2;

export interface GlassGeometry {
  /** Rounded size, the filter's identity together with the radius. */
  width: number;
  height: number;
  radius: number;
  /** Depth of the bending rim. */
  band: number;
  /** `feDisplacementMap` scale: the bend at the edge. */
  scale: number;
  /** A stable id for this geometry's filter. */
  key: string;
}

/**
 * The filter a layer of this size and corner radius needs. The rim and bend are fixed in pixels,
 * so a tooltip and a 600px palette bend alike instead of scaling with their box.
 */
export function glassGeometry(width: number, height: number, radius: number): GlassGeometry {
  const w = Math.max(sizeStep, Math.round(width / sizeStep) * sizeStep);
  const h = Math.max(sizeStep, Math.round(height / sizeStep) * sizeStep);
  const r = Math.max(0, Math.min(Math.round(radius), Math.floor(Math.min(w, h) / 2)));
  const band = Math.max(1, Math.min(maxBand, Math.floor(Math.min(w, h) / 2.4)));
  const scale = Math.min(maxBend, band);
  return { width: w, height: h, radius: r, band, scale, key: `${w}x${h}r${r}` };
}

/**
 * The displacement map as RGBA pixels: red and green push each pixel inward near the rounded
 * rect's rim (strongest at the edge, flat in the middle), so the backdrop bends at the edge like
 * thick glass. 128 is no displacement. Only the rim is computed; the middle is a flat fill.
 */
export function edgeMap(geometry: GlassGeometry): Uint8ClampedArray {
  const { width, height, radius, band } = geometry;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 128;
    pixels[i + 1] = 128;
    pixels[i + 2] = 128;
    pixels[i + 3] = 255;
  }
  const hx = width / 2;
  const hy = height / 2;
  const reach = Math.max(band, radius) + 1;
  const write = (x: number, y: number) => {
    const px = x + 0.5 - hx;
    const py = y + 0.5 - hy;
    const qx = Math.abs(px) - (hx - radius);
    const qy = Math.abs(py) - (hy - radius);
    let distance: number;
    let nx: number;
    let ny: number;
    if (qx > 0 && qy > 0) {
      const length = Math.hypot(qx, qy);
      distance = length - radius;
      nx = qx / length;
      ny = qy / length;
    } else if (qx > qy) {
      distance = qx - radius;
      nx = 1;
      ny = 0;
    } else {
      distance = qy - radius;
      nx = 0;
      ny = 1;
    }
    const depth = -distance;
    if (distance > 0 || depth >= band) return;
    const t = 1 - depth / band;
    const strength = t * t;
    const i = (y * width + x) * 4;
    pixels[i] = 128 - Math.sign(px) * nx * strength * 127;
    pixels[i + 1] = 128 - Math.sign(py) * ny * strength * 127;
  };
  for (let y = 0; y < height; y++) {
    const edgeRow = y < reach || y >= height - reach;
    if (edgeRow) for (let x = 0; x < width; x++) write(x, y);
    else
      for (let x = 0; x < Math.min(reach, width); x++) {
        write(x, y);
        write(width - 1 - x, y);
      }
  }
  return pixels;
}
