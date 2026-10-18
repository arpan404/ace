import { h, place } from "./dom.ts";
import { describeElement } from "./pick.ts";
import type { CaptureRect, OverlayElement } from "./types.ts";

/** A box in CSS px: document coordinates for records, viewport coordinates while dragging. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Most elements a region names; mirrors `browserAnnotationRegionElementLimit`. */
const elementLimit = 8;
/** Share of an element's own area that must fall inside the region for it to count. */
const mostlyInside = 0.6;
/** Elements whose content is not page structure the agent can act on. */
const skipped = new Set(["script", "style", "noscript", "template", "head", "meta", "link", "br"]);

/** The rectangle between two viewport points. */
export function between(a: { x: number; y: number }, b: { x: number; y: number }): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/** The dashed selection rectangle drawn while the person drags out an area. */
export function createMarquee(parent: HTMLElement) {
  const node = h("div", { class: "region marquee" });
  return {
    show(box: Box): void {
      if (!node.isConnected) parent.append(node);
      place(node, {
        translate: `${box.x}px ${box.y}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
      });
    },
    hide(): void {
      node.remove();
    },
  };
}

function area(box: { width: number; height: number }): number {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

function overlap(rect: DOMRect, box: Box): number {
  const width = Math.min(rect.right, box.x + box.width) - Math.max(rect.left, box.x);
  const height = Math.min(rect.bottom, box.y + box.height) - Math.max(rect.top, box.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function visible(element: Element): boolean {
  if (skipped.has(element.localName)) return false;
  const style = getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "contents" && style.opacity !== "0";
}

/**
 * The outermost page elements mostly inside a viewport box, in document order. When that is a
 * single wrapper, its children are named instead, so the agent sees the button and the text
 * rather than the div around them. Subtrees whose box misses the region are not walked.
 */
export function elementsInside(box: Box, host: Element): Element[] {
  const outermost = (parent: Element): Element[] => {
    const found: Element[] = [];
    for (const child of parent.children) {
      if (child === host || found.length >= elementLimit) continue;
      const rect = child.getBoundingClientRect();
      const shown = overlap(rect, box);
      if (shown === 0) {
        // A box-less wrapper (`display: contents`, an empty float parent) can still hold
        // elements inside the region; anything with a box elsewhere is skipped whole.
        if (area(rect) === 0 && child.children.length)
          found.push(...outermost(child).slice(0, elementLimit - found.length));
        continue;
      }
      if (area(rect) >= 4 && shown / area(rect) >= mostlyInside && visible(child))
        found.push(child);
      else found.push(...outermost(child).slice(0, elementLimit - found.length));
    }
    return found;
  };
  let found = outermost(document.body ?? document.documentElement);
  for (let depth = 0; found.length === 1 && depth < 8; depth++) {
    const [only] = found;
    if (!only) break;
    const inner = outermost(only);
    if (!inner.length) break;
    found = inner;
  }
  return found.slice(0, elementLimit);
}

/** The deepest element whose box holds the whole region: where on the page it sits. */
export function containerOf(box: Box, host: Element): Element {
  const centre = document
    .elementsFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    .find((element) => element !== host && !host.contains(element));
  for (let node: Element | null = centre ?? null; node; node = node.parentElement) {
    const rect = node.getBoundingClientRect();
    if (
      rect.left <= box.x + 1 &&
      rect.top <= box.y + 1 &&
      rect.right >= box.x + box.width - 1 &&
      rect.bottom >= box.y + box.height - 1
    )
      return node;
  }
  return document.body ?? document.documentElement;
}

/** What a region record says about the page under a viewport box. */
export function describeRegion(
  box: Box,
  host: Element,
): { container: OverlayElement; elements: OverlayElement[]; document: Box } {
  return {
    container: describeElement(containerOf(box, host)),
    elements: elementsInside(box, host).map((element) => {
      const description = describeElement(element);
      description.text = description.text.slice(0, 160);
      return description;
    }),
    document: {
      x: Math.round(box.x + scrollX),
      y: Math.round(box.y + scrollY),
      width: Math.round(box.width),
      height: Math.round(box.height),
    },
  };
}

/** A recorded region's viewport box now; a capture crops it exactly, without a margin. */
export function regionRect(box: Box): CaptureRect {
  return {
    x: box.x - scrollX,
    y: box.y - scrollY,
    width: box.width,
    height: box.height,
    margin: 0,
  };
}
