/*
 * Liquid glass for floating layers (docs/design/visual-language.md, "Glass"). Chromium, Electron
 * included, renders an SVG filter through `backdrop-filter: url()`, so floating layers there bend
 * what's behind them at the rim. Safari and Firefox drop that silently while `CSS.supports` still
 * says yes, so the engine is read from the user agent and they get blur and saturate instead.
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

/** The id `styles/glass.css` reads through `backdrop-filter: url(#…)`. */
export const liquidFilterId = "ace-liquid-glass";

/**
 * The displacement map as RGBA pixels: red and green push each pixel inward near a rounded
 * rect's rim (strongest at the edge, flat in the middle), so the backdrop bends at the edge like
 * thick glass. 128 is no displacement. The filter stretches it over each layer's box.
 */
export function edgeMap(size: number, radius: number, band: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(size * size * 4);
  const half = size / 2;
  const r = Math.min(radius, half);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const px = x + 0.5 - half;
      const py = y + 0.5 - half;
      const qx = Math.abs(px) - (half - r);
      const qy = Math.abs(py) - (half - r);
      let distance: number;
      let nx: number;
      let ny: number;
      if (qx > 0 && qy > 0) {
        const length = Math.hypot(qx, qy);
        distance = length - r;
        nx = qx / length;
        ny = qy / length;
      } else if (qx > qy) {
        distance = qx - r;
        nx = 1;
        ny = 0;
      } else {
        distance = qy - r;
        nx = 0;
        ny = 1;
      }
      nx *= px < 0 ? -1 : 1;
      ny *= py < 0 ? -1 : 1;
      const depth = Math.max(0, -distance);
      const t = distance > 0 || depth >= band ? 0 : 1 - depth / band;
      const strength = t * t;
      const i = (y * size + x) * 4;
      pixels[i] = 128 - nx * strength * 127;
      pixels[i + 1] = 128 - ny * strength * 127;
      pixels[i + 2] = 128;
      pixels[i + 3] = 255;
    }
  return pixels;
}

const svgNs = "http://www.w3.org/2000/svg";

function setAttributes(element: Element, attributes: Record<string, string>) {
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
}
const mapSize = 160;

/** The map as a PNG data URL, or undefined where there's no 2D canvas. */
function edgeMapUrl(document: Document): string | undefined {
  const canvas = document.createElement("canvas");
  canvas.width = mapSize;
  canvas.height = mapSize;
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  const image = context.createImageData(mapSize, mapSize);
  image.data.set(edgeMap(mapSize, 22, 18));
  context.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

/**
 * Adds the one shared filter to the page, once. Units are the layer's own box, so a single
 * filter fits every popover, menu and dialog without per-element work. False when it can't.
 */
export function installLiquidGlass(document: Document): boolean {
  if (document.getElementById(liquidFilterId)) return true;
  const map = edgeMapUrl(document);
  if (!map) return false;
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("style", "position:absolute;width:0;height:0;pointer-events:none");
  const filter = document.createElementNS(svgNs, "filter");
  setAttributes(filter, {
    id: liquidFilterId,
    x: "0",
    y: "0",
    width: "1",
    height: "1",
    filterUnits: "objectBoundingBox",
    primitiveUnits: "objectBoundingBox",
    "color-interpolation-filters": "sRGB",
  });
  const image = document.createElementNS(svgNs, "feImage");
  setAttributes(image, {
    href: map,
    x: "0",
    y: "0",
    width: "1",
    height: "1",
    preserveAspectRatio: "none",
    result: "edge",
  });
  const displace = document.createElementNS(svgNs, "feDisplacementMap");
  setAttributes(displace, {
    in: "SourceGraphic",
    in2: "edge",
    scale: "0.08",
    xChannelSelector: "R",
    yChannelSelector: "G",
  });
  filter.append(image, displace);
  svg.append(filter);
  document.body.append(svg);
  return true;
}
