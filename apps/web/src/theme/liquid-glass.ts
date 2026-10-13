import { edgeMap, fitStep, glassGeometry, mapSize, type GlassGeometry } from "./glass.ts";

/*
 * The DOM half of liquid glass. Each floating layer gets an SVG filter sized to its own box at the
 * screen's pixel density, so the rim stays a fixed, thin band whatever the layer's size and its
 * corners match the layer's radius. Filters are shared by every layer of the same geometry and
 * cached.
 *
 * Nothing runs per frame. A layer announces itself when it appears: under liquid glass its
 * `::before` plays a 1ms marker animation (styles/glass.css), whose `animationstart` bubbles to
 * the document. One ResizeObserver re-measures layers only when their size changes. The map is
 * encoded off the main thread (`toBlob`), and a layer shows plain frosted glass until it lands.
 */

const svgNs = "http://www.w3.org/2000/svg";
const containerId = "ace-liquid-glass";
const markerAnimation = "ace-glass-mount";
/** How long a layer's size must hold before it gets a filter for that size. */
const settleMs = 160;
/** Unused filters beyond this many are dropped, oldest first. */
const maxCachedFilters = 16;

interface Filter {
  element: SVGFilterElement | undefined;
  /** The map's object URL, revoked when the filter goes. */
  url: string | undefined;
  geometry: GlassGeometry;
  users: Set<HTMLElement>;
  dropped: boolean;
}

function setAttributes(element: Element, attributes: Record<string, string | number>) {
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
}

/** The map as an object URL, encoded off the main thread; undefined where there's no 2D canvas. */
function mapUrl(document: Document, geometry: GlassGeometry): Promise<string | undefined> {
  const canvas = document.createElement("canvas");
  const size = mapSize(geometry);
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context || typeof canvas.toBlob !== "function") return Promise.resolve(undefined);
  const image = context.createImageData(size.width, size.height);
  image.data.set(edgeMap(geometry));
  context.putImageData(image, 0, 0);
  const view = document.defaultView;
  return new Promise((resolve) =>
    canvas.toBlob((blob) => resolve(blob && view ? view.URL.createObjectURL(blob) : undefined)),
  );
}

/**
 * Blur and saturate come first in the CSS chain (styles/glass.css), so this filter bends an
 * already frosted backdrop: the rim shifts colour and light, and never sharp text.
 */
function createFilter(document: Document, geometry: GlassGeometry, map: string): SVGFilterElement {
  const box = { x: 0, y: 0, width: geometry.width, height: geometry.height };
  const filter = document.createElementNS(svgNs, "filter");
  setAttributes(filter, {
    id: `ace-glass-${geometry.key.replaceAll(".", "_")}`,
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
  /** Each observed layer and its filter: undefined before its first, null while it has none. */
  const layers = new Map<HTMLElement, Filter | null | undefined>();
  const pending = new Map<HTMLElement, ReturnType<typeof setTimeout>>();

  const drop = (key: string, filter: Filter) => {
    filter.dropped = true;
    filter.element?.remove();
    if (filter.url) view.URL.revokeObjectURL(filter.url);
    filters.delete(key);
  };
  const prune = () => {
    for (const [key, filter] of filters) {
      if (filters.size <= maxCachedFilters) break;
      if (filter.users.size === 0) drop(key, filter);
    }
  };
  const show = (layer: HTMLElement, filter: Filter) => {
    if (filter.element) layer.style.setProperty("--liquid-filter", `url(#${filter.element.id})`);
  };
  const release = (layer: HTMLElement) => {
    layers.get(layer)?.users.delete(layer);
    layer.style.removeProperty("--liquid-filter");
  };
  const forget = (layer: HTMLElement) => {
    clearTimeout(pending.get(layer));
    pending.delete(layer);
    release(layer);
    layers.delete(layer);
    resize.unobserve(layer);
  };
  const fit = (layer: HTMLElement, geometry: GlassGeometry) => {
    if (!layer.isConnected) return;
    let filter = filters.get(geometry.key);
    if (filter) {
      // Most recently used last, so pruning drops the oldest first.
      filters.delete(geometry.key);
      filters.set(geometry.key, filter);
    } else {
      const created: Filter = {
        element: undefined,
        url: undefined,
        geometry,
        users: new Set(),
        dropped: false,
      };
      filter = created;
      filters.set(geometry.key, created);
      void mapUrl(document, geometry).then((url) => {
        if (!url) return;
        if (created.dropped) return view.URL.revokeObjectURL(url);
        created.url = url;
        created.element = createFilter(document, geometry, url);
        container.append(created.element);
        for (const user of created.users) show(user, created);
      });
    }
    release(layer);
    filter.users.add(layer);
    layers.set(layer, filter);
    show(layer, filter);
    prune();
  };
  /** Takes the layer's rim off until it is fitted again: frosted glass, never a misplaced bend. */
  const unfit = (layer: HTMLElement) => {
    release(layer);
    layers.set(layer, null);
  };
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
      const geometry = glassGeometry(width, height, radius, view.devicePixelRatio);
      clearTimeout(pending.get(layer));
      pending.delete(layer);
      const current = layers.get(layer);
      const step = fitStep(
        current === undefined ? undefined : (current?.geometry ?? null),
        geometry,
      );
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
    for (const [key, filter] of filters) drop(key, filter);
    container.remove();
  };
}
