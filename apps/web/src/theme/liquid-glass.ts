import { edgeMap, fitStep, glassGeometry, type GlassGeometry } from "./glass.ts";

/*
 * The DOM half of liquid glass. Each floating layer gets an SVG filter sized to its own box, so
 * the rim and bend stay a fixed number of pixels whatever the layer's size, and its corners match
 * the layer's radius. Filters are shared by every layer of the same geometry and cached.
 *
 * Nothing runs per frame. A layer announces itself when it appears: under liquid glass its
 * `::before` plays a 1ms marker animation (styles/glass.css), whose `animationstart` bubbles to
 * the document. One ResizeObserver re-measures layers only when their size changes.
 */

const svgNs = "http://www.w3.org/2000/svg";
const containerId = "ace-liquid-glass";
const markerAnimation = "ace-glass-mount";
/** How long a layer's size must hold before it gets a filter for that size. */
const settleMs = 160;
/** Unused filters beyond this many are dropped, oldest first. */
const maxCachedFilters = 24;

interface Filter {
  element: SVGFilterElement;
  users: number;
}

function setAttributes(element: Element, attributes: Record<string, string | number>) {
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
}

/** The map as a PNG data URL, or undefined where there's no 2D canvas. */
function mapUrl(document: Document, geometry: GlassGeometry): string | undefined {
  const canvas = document.createElement("canvas");
  canvas.width = geometry.width;
  canvas.height = geometry.height;
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  const image = context.createImageData(geometry.width, geometry.height);
  image.data.set(edgeMap(geometry));
  context.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

function createFilter(document: Document, geometry: GlassGeometry): SVGFilterElement | undefined {
  const map = mapUrl(document, geometry);
  if (!map) return undefined;
  const box = { x: 0, y: 0, width: geometry.width, height: geometry.height };
  const filter = document.createElementNS(svgNs, "filter");
  setAttributes(filter, {
    id: `ace-glass-${geometry.key}`,
    ...box,
    filterUnits: "userSpaceOnUse",
    primitiveUnits: "userSpaceOnUse",
    "color-interpolation-filters": "sRGB",
  });
  const image = document.createElementNS(svgNs, "feImage");
  setAttributes(image, { href: map, ...box, preserveAspectRatio: "none", result: "edge" });
  const displace = document.createElementNS(svgNs, "feDisplacementMap");
  setAttributes(displace, {
    in: "SourceGraphic",
    in2: "edge",
    scale: geometry.scale,
    xChannelSelector: "R",
    yChannelSelector: "G",
  });
  filter.append(image, displace);
  return filter;
}

/**
 * Starts liquid glass on `document`; the returned function stops it and removes every filter.
 * Layers keep blur and saturate while they have no filter yet, so nothing waits on this.
 */
export function startLiquidGlass(document: Document): () => void {
  const view = document.defaultView;
  if (!view || typeof view.ResizeObserver === "undefined") return () => {};
  const container = document.createElementNS(svgNs, "svg");
  setAttributes(container, {
    id: containerId,
    "aria-hidden": "true",
    width: 0,
    height: 0,
    style: "position:absolute;width:0;height:0;pointer-events:none",
  });
  document.body.append(container);

  const filters = new Map<string, Filter>();
  /** Each observed layer and the key of its filter: undefined before its first, "" while none. */
  const layers = new Map<HTMLElement, string | undefined>();

  const release = (key: string | undefined) => {
    const filter = key === undefined ? undefined : filters.get(key);
    if (filter) filter.users--;
  };
  const prune = () => {
    if (filters.size <= maxCachedFilters) return;
    for (const [key, filter] of filters) {
      if (filters.size <= maxCachedFilters) break;
      if (filter.users > 0) continue;
      filter.element.remove();
      filters.delete(key);
    }
  };
  const forget = (layer: HTMLElement) => {
    clearTimeout(pending.get(layer));
    pending.delete(layer);
    release(layers.get(layer));
    layers.delete(layer);
    resize.unobserve(layer);
  };
  const fit = (layer: HTMLElement, geometry: GlassGeometry) => {
    if (!layer.isConnected) return;
    let filter = filters.get(geometry.key);
    if (!filter) {
      const element = createFilter(document, geometry);
      if (!element) return;
      container.append(element);
      filter = { element, users: 0 };
      filters.set(geometry.key, filter);
    } else {
      // Most recently used last, so pruning drops the oldest first.
      filters.delete(geometry.key);
      filters.set(geometry.key, filter);
    }
    release(layers.get(layer));
    filter.users++;
    layers.set(layer, geometry.key);
    layer.style.setProperty("--liquid-filter", `url(#${filter.element.id})`);
    prune();
  };
  /** Takes the layer's rim off until it is fitted again: blur alone, never a misplaced bend. */
  const unfit = (layer: HTMLElement) => {
    release(layers.get(layer));
    layers.set(layer, "");
    layer.style.removeProperty("--liquid-filter");
  };
  const pending = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  const resize = new view.ResizeObserver((entries) => {
    for (const entry of entries) {
      const layer = entry.target;
      if (!(layer instanceof view.HTMLElement)) continue;
      if (!layer.isConnected) {
        forget(layer);
        continue;
      }
      const box = entry.borderBoxSize[0];
      const width = box?.inlineSize ?? layer.offsetWidth;
      const height = box?.blockSize ?? layer.offsetHeight;
      if (width < 8 || height < 8) continue;
      const radius = Number.parseFloat(view.getComputedStyle(layer).borderTopLeftRadius) || 0;
      const geometry = glassGeometry(width, height, radius);
      clearTimeout(pending.get(layer));
      pending.delete(layer);
      const step = fitStep(layers.get(layer), geometry);
      if (step === "now") fit(layer, geometry);
      else if (step === "settle") {
        unfit(layer);
        pending.set(
          layer,
          setTimeout(() => {
            pending.delete(layer);
            fit(layer, geometry);
          }, settleMs),
        );
      }
    }
  });
  const mounted = (event: AnimationEvent) => {
    if (event.animationName !== markerAnimation) return;
    const layer = event.target;
    if (!(layer instanceof view.HTMLElement) || layers.has(layer)) return;
    // Layers that closed since the last one opened stop being observed.
    for (const known of layers.keys()) if (!known.isConnected) forget(known);
    layers.set(layer, undefined);
    resize.observe(layer);
  };
  document.addEventListener("animationstart", mounted, true);

  return () => {
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    document.removeEventListener("animationstart", mounted, true);
    resize.disconnect();
    for (const layer of layers.keys()) layer.style.removeProperty("--liquid-filter");
    layers.clear();
    filters.clear();
    container.remove();
  };
}
