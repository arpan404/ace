import { protectedSuitParts, suitRegions } from "@ace/protocol/suit-parts";
import type { Rgb } from "@/theme/contrast.ts";
import {
  cellsUnder,
  gradientStops,
  over,
  parseComputedColour,
  type Box,
  type ColourSample,
  type PaintLayer,
  type Rgba,
} from "./colour-check.ts";
import type { OverflowSample, ProtectedSample } from "./layout-check.ts";
import type { SceneFrame } from "./scene-sample.ts";

/*
 * The live check's DOM shell (ADR 0150, "Shown perfectly"): reads the rendered page into the
 * plain samples `colour-check.ts` and `layout-check.ts` judge. Only `[data-part]` elements are
 * read; class names and DOM depth stay out of it, as they stay out of the Suit contract.
 */

/** Text parts read at most; a long transcript repeats the same few parts. */
const maxColourSamples = 900;
/** Text holders read per part element. */
const perElement = 3;

const boxOf = (element: Element): Box => {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
};

/** Turns any CSS colour into RGBA: computed values parse directly, the rest through a canvas. */
export function colourReader(document: Document): (value: string) => Rgba | undefined {
  const known = new Map<string, Rgba | undefined>();
  let context: CanvasRenderingContext2D | null | undefined;
  return (value) => {
    if (known.has(value)) return known.get(value);
    let colour = parseComputedColour(value);
    if (!colour) {
      context ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
      if (context) {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = "rgba(0, 0, 0, 0)";
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
        colour = [r, g, b, a / 255];
      }
    }
    known.set(value, colour);
    return colour;
  };
}

type Read = (value: string) => Rgba | undefined;

/** An element's paint, or `image` when its background is a picture the check can't read. */
function layerOf(element: Element, read: Read): PaintLayer | "image" {
  const style = getComputedStyle(element);
  const image = style.backgroundImage;
  if (image && image !== "none" && /url\(/i.test(image)) return "image";
  const stops: Rgba[] = [];
  if (image && image !== "none")
    for (const stop of gradientStops(image)) {
      const colour = read(stop);
      if (colour) stops.push(colour);
    }
  const opacity = Number(style.opacity);
  return {
    color: read(style.backgroundColor) ?? [0, 0, 0, 0],
    stops,
    opacity: Number.isFinite(opacity) ? opacity : 1,
  };
}

const opaque = (layer: PaintLayer) =>
  layer.color[3] >= 1 && layer.opacity >= 1 && layer.stops.every((stop) => stop[3] >= 1);

/** The colour an element's ancestors settle to, ignoring scenes: the base under a scene. */
function solidBelow(element: Element | null, read: Read): Rgb {
  const layers: PaintLayer[] = [];
  for (let at = element; at; at = at.parentElement) {
    const layer = layerOf(at, read);
    if (layer === "image") continue;
    layers.unshift({ ...layer, stops: [] });
    if (opaque(layer)) break;
  }
  let colour: Rgb = [255, 255, 255];
  for (const layer of layers) colour = over(layer.color, colour, layer.opacity);
  return colour;
}

/** The scene frame whose host holds `element`, the innermost one when several do. */
const sceneFor = (element: Element, scenes: readonly SceneFrame[]) =>
  scenes
    .filter((scene) => scene.host.contains(element))
    .toSorted((a, b) => (a.host.contains(b.host) ? 1 : -1))[0];

/**
 * The scene's cells as they show through its veils. A veil is a sibling painted over the scene
 * and under the host's content, so its opacity tints what the text sits on and never the text.
 * Each gradient stop of a veil is a backdrop of its own, so the worst one counts.
 */
function underVeils(veils: readonly Element[], cells: readonly Rgb[], read: Read): Rgb[] {
  let shown = [...cells];
  for (const veil of veils) {
    const layer = layerOf(veil, read);
    if (layer === "image") continue;
    shown = shown.flatMap((cell) => {
      const painted = over(layer.color, cell);
      const choices = layer.stops.length
        ? layer.stops.map((stop) => over(stop, painted))
        : [painted];
      return choices.map((choice) => over([...choice, 1], cell, layer.opacity));
    });
  }
  return shown;
}

/**
 * The layers from what lies beneath `holder` up to it, and the backdrop under those. Undefined
 * when the background can't be read (an image, or a scene that gave no sample).
 */
function background(
  holder: Element,
  box: Box,
  scenes: readonly SceneFrame[],
  read: Read,
): { layers: PaintLayer[]; backdrop: Rgb[] } | undefined {
  const scene = sceneFor(holder, scenes);
  const layers: PaintLayer[] = [];
  for (let at: Element | null = holder; at; at = at.parentElement) {
    if (scene && at === scene.host) {
      if (!scene.grid) return undefined;
      const cells = cellsUnder(scene.grid, box, solidBelow(scene.host, read));
      const backdrop = cells.length ? cells : [solidBelow(scene.host, read)];
      return { layers, backdrop: underVeils(scene.veils, backdrop, read) };
    }
    const layer = layerOf(at, read);
    if (layer === "image") return undefined;
    layers.unshift(layer);
    if (opaque(layer)) break;
  }
  return { layers, backdrop: [[255, 255, 255]] };
}

/** Elements holding the part's own text: text nodes whose nearest part is this one. */
function textHolders(part: Element): Element[] {
  const holders = new Set<Element>();
  const walker = part.ownerDocument.createTreeWalker(part, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && holders.size < perElement; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !node.textContent?.trim()) continue;
    if (parent.closest("[data-part]") !== part) continue;
    holders.add(parent);
  }
  return [...holders];
}

/** The part's own icon. A Suit's ornament is decoration (hidden from assistive tech), not one. */
const markOf = (part: Element) =>
  [...part.querySelectorAll("svg")].find(
    (svg) => svg.closest("[data-part]") === part && !svg.closest("[data-ornament]"),
  );

const shows = (element: Element, box: Box) => {
  if (box.width < 1 || box.height < 1) return false;
  const style = getComputedStyle(element);
  return style.visibility === "visible";
};

/** The colour an icon is drawn in: its fill when that is a colour, else its stroke or `color`. */
function markColour(svg: Element, read: Read): Rgba | undefined {
  const style = getComputedStyle(svg);
  for (const value of [style.fill, style.stroke, style.color]) {
    if (!value || value === "none" || value.startsWith("url(")) continue;
    const colour = read(value);
    if (colour && colour[3] > 0) return colour;
  }
  return undefined;
}

export interface ColourReading {
  samples: ColourSample[];
  /** Parts whose background couldn't be read. */
  unchecked: string[];
}

export function readColours(
  root: ParentNode,
  scenes: readonly SceneFrame[],
  read: Read,
): ColourReading {
  const samples: ColourSample[] = [];
  const unchecked = new Set<string>();
  for (const part of root.querySelectorAll("[data-part]")) {
    if (samples.length >= maxColourSamples) break;
    const name = part.getAttribute("data-part") ?? "";
    const holders = textHolders(part);
    const mark = holders.length === 0 ? markOf(part) : undefined;
    const targets: [Element, "text" | "mark"][] = mark
      ? [[mark, "mark"]]
      : holders.map((holder) => [holder, "text"]);
    for (const [target, kind] of targets) {
      const box = boxOf(target);
      if (!shows(target, box)) continue;
      const style = getComputedStyle(target);
      const fg = kind === "mark" ? markColour(target, read) : read(style.color);
      if (!fg) continue;
      const behind = background(target, box, scenes, read);
      if (!behind) {
        unchecked.add(name);
        continue;
      }
      samples.push({
        part: name,
        kind,
        fg,
        ...behind,
        fontSize: Number.parseFloat(style.fontSize) || 16,
        fontWeight: Number.parseFloat(style.fontWeight) || 400,
      });
    }
  }
  return { samples, unchecked: [...unchecked] };
}

/** Opacity of the element times every ancestor's. */
function shownOpacity(element: Element): number {
  let opacity = 1;
  for (let at: Element | null = element; at; at = at.parentElement) {
    const value = Number(getComputedStyle(at).opacity);
    if (Number.isFinite(value)) opacity *= value;
  }
  return opacity;
}

/** Whether an ancestor is display: none, which is ace's doing (a closed panel), not the Suit's. */
function inClosedPanel(element: Element): boolean {
  for (let at = element.parentElement; at; at = at.parentElement)
    if (getComputedStyle(at).display === "none") return true;
  return false;
}

export function readProtected(root: ParentNode, document: Document): ProtectedSample[] {
  const view = document.defaultView;
  const samples: ProtectedSample[] = [];
  for (const part of protectedSuitParts)
    for (const element of root.querySelectorAll(`[data-part="${part}"]`)) {
      if (inClosedPanel(element)) continue;
      const style = getComputedStyle(element);
      const box = boxOf(element);
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const offscreen = !view || x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight;
      const top = offscreen ? null : document.elementFromPoint(x, y);
      samples.push({
        part,
        box,
        display: style.display,
        visibility: style.visibility,
        opacity: shownOpacity(element),
        hit: offscreen ? "offscreen" : top !== null && (top === element || element.contains(top)),
      });
    }
  return samples;
}

const regionNames: ReadonlySet<string> = new Set(suitRegions);
const scrollsSideways = (value: string) => value === "auto" || value === "scroll";

export function readOverflow(root: ParentNode): OverflowSample[] {
  const samples: OverflowSample[] = [];
  for (const element of root.querySelectorAll("[data-part]")) {
    const part = element.getAttribute("data-part") ?? "";
    if (part === "app") continue;
    let region: Element | undefined;
    let scrolls = false;
    for (let at = element.parentElement; at; at = at.parentElement) {
      const name = at.getAttribute("data-part");
      if (name && regionNames.has(name)) {
        region = at;
        break;
      }
      if (scrollsSideways(getComputedStyle(at).overflowX)) scrolls = true;
    }
    if (!region) continue;
    const box = boxOf(element);
    if (box.width < 1 || box.height < 1) continue;
    const style = getComputedStyle(element);
    const spills =
      style.overflowX === "visible" &&
      style.textOverflow !== "ellipsis" &&
      element.scrollWidth > element.clientWidth + 1 &&
      element.clientWidth > 0;
    samples.push({
      part,
      region: region.getAttribute("data-part") ?? "app",
      box,
      regionBox: boxOf(region),
      scrolls,
      spills,
    });
  }
  return samples;
}
