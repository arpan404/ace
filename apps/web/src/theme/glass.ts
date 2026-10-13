/*
 * Liquid glass for floating layers (docs/design/visual-language.md, "Glass"): the pure half.
 * Chromium, Electron included, renders an SVG filter through `backdrop-filter: url()`, so floating
 * layers there bend what's behind them at the rim. Safari and Firefox drop that silently while
 * `CSS.supports` still says yes, so the engine is read from the user agent and they get blur and
 * saturate instead. The DOM shell that measures layers and keeps their filters is liquid-glass.ts.
 *
 * The bend follows Apple's Liquid Glass: lensing lives at the edge and never in the middle, so
 * the backdrop is blurred first and only then bent, inside a thin rim. Text behind a layer is
 * never warped; the rim reads as the thickness of the glass catching what's behind it.
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

/** The rim that bends, in CSS px: thin, so it reads as an edge and not as a lens over the content. */
const maxBand = 10;
/** How far the blurred backdrop moves at the very edge, in CSS px. */
const maxBend = 7;
/** Below this many CSS px of difference, a layer keeps the filter it has. */
const jitter = 1;

export interface GlassGeometry {
  /** Size in CSS px, the filter's identity together with the radius and pixel density. */
  width: number;
  height: number;
  radius: number;
  /** Device pixels per CSS px the map is drawn at, so its gradient is smooth on HiDPI. */
  density: number;
  /** Depth of the bending rim, CSS px. */
  band: number;
  /** `feDisplacementMap` scale: the bend at the edge, CSS px. */
  scale: number;
  /** A stable id for this geometry's filter. */
  key: string;
}

/**
 * The filter a layer of this size, corner radius and pixel density needs. The rim and bend are
 * fixed in CSS pixels, so a 600px palette and a 200px menu bend alike; a layer too small for the
 * full rim gets a shallower one rather than a bend through its text.
 */
export function glassGeometry(
  width: number,
  height: number,
  radius: number,
  devicePixelRatio = 1,
): GlassGeometry {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const r = Math.max(0, Math.min(Math.round(radius), Math.floor(Math.min(w, h) / 2)));
  const density = Math.min(3, Math.max(1, Math.round(devicePixelRatio * 2) / 2));
  const band = Math.max(1, Math.min(maxBand, Math.floor(Math.min(w, h) / 5)));
  const scale = Math.min(maxBend, Math.round(band * 0.7));
  return { width: w, height: h, radius: r, density, band, scale, key: `${w}x${h}r${r}d${density}` };
}

/** What a measured layer needs from its filter. */
export type FitStep = "now" | "keep" | "settle";

/**
 * A layer measured for the first time gets its filter at once, so it opens with its rim. One that
 * measures within a pixel of its filter keeps it. One whose size changed loses its rim straight
 * away (a filter sized for the old box would bend the wrong edge) and gets a new one once its size
 * holds still, so a list filtering as you type builds one filter, not one per height on the way.
 * `fitted` is the geometry of the filter it has: undefined before its first, null while it has none.
 */
export function fitStep(
  fitted: GlassGeometry | null | undefined,
  measured: GlassGeometry,
): FitStep {
  if (fitted === undefined) return "now";
  if (fitted === null) return "settle";
  const same =
    Math.abs(fitted.width - measured.width) <= jitter &&
    Math.abs(fitted.height - measured.height) <= jitter &&
    fitted.radius === measured.radius &&
    fitted.density === measured.density;
  return same ? "keep" : "settle";
}

/** The map's size in device pixels. */
export function mapSize(geometry: GlassGeometry): { width: number; height: number } {
  return {
    width: Math.round(geometry.width * geometry.density),
    height: Math.round(geometry.height * geometry.density),
  };
}

/**
 * The displacement map as RGBA pixels at the geometry's density: inside a thin rim along the
 * rounded rect, red and green pull each pixel from further in (strongest at the edge, easing to
 * nothing at the rim's inner side along a smooth curve), like light bending through the thick
 * edge of a pane. 128 is no displacement, and everything inside the rim is exactly 128.
 */
export function edgeMap(geometry: GlassGeometry): Uint8ClampedArray {
  const { density } = geometry;
  const { width, height } = mapSize(geometry);
  const radius = geometry.radius * density;
  const band = geometry.band * density;
  const pixels = new Uint8ClampedArray(width * height * 4);
  // One write per pixel for the flat fill: 0xff808080 is RGBA 128,128,128,255 little-endian.
  new Uint32Array(pixels.buffer).fill(0xff808080);
  const hx = width / 2;
  const hy = height / 2;
  const reach = Math.ceil(Math.max(band, radius)) + 1;
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
    // Smoothstep from the rim's inner side to the edge, squared so most of the bend sits at the
    // very edge and the inner side meets the flat middle with no visible seam.
    const t = 1 - depth / band;
    const strength = t * t * (3 - 2 * t) * t;
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
