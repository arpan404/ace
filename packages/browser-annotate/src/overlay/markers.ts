import { h, place } from "./dom.ts";

export interface Anchor {
  element: Element;
  /** Fraction of the element's box. */
  point: { x: number; y: number };
}
interface Marker extends Anchor {
  node: HTMLElement;
}

/**
 * Numbered markers pinned to page elements. Positions are recomputed once per frame from the
 * element's box, so markers follow scrolling (inner containers included), resizes and reflows.
 */
export function createMarkers(parent: HTMLElement, onOpen: (id: string) => void) {
  const container = h("div", { class: "markers" });
  parent.append(container);
  // A marker sits over page content: wheel over it scrolls whatever is underneath.
  container.addEventListener(
    "wheel",
    (event) => {
      if (!event.isTrusted) return;
      const root = parent.getRootNode();
      const host = root instanceof ShadowRoot ? root.host : null;
      const below = document
        .elementsFromPoint(event.clientX, event.clientY)
        .find((element) => element !== host);
      const target = scrollable(below ?? null, event.deltaX, event.deltaY);
      if (!target) return;
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      target.scrollBy({ left: event.deltaX * unit, top: event.deltaY * unit });
    },
    { passive: false },
  );
  const markers = new Map<string, Marker>();
  const resize = new ResizeObserver(() => schedule());
  let frame = 0;
  let afterUpdate: () => void = noop;

  function position(id: string): { x: number; y: number } | null {
    const marker = markers.get(id);
    if (!marker?.element.isConnected) return null;
    const rect = marker.element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return {
      x: rect.left + marker.point.x * rect.width,
      y: rect.top + marker.point.y * rect.height,
    };
  }
  function update(): void {
    frame = 0;
    for (const [id, marker] of markers) {
      const at = position(id);
      marker.node.classList.toggle("lost", !at);
      if (at) place(marker.node, { translate: `${at.x}px ${at.y}px` });
    }
    afterUpdate();
  }
  function schedule(): void {
    if (!frame) frame = requestAnimationFrame(update);
  }
  function set(id: string, anchor: Anchor, number?: number): void {
    let marker = markers.get(id);
    if (!marker) {
      const node = h("div", { attrs: { role: "button", tabindex: "-1" } });
      node.addEventListener("click", (event) => {
        if (!event.isTrusted || node.classList.contains("pending")) return;
        event.preventDefault();
        onOpen(id);
      });
      marker = { ...anchor, node };
      markers.set(id, marker);
      container.append(node);
    } else if (marker.element !== anchor.element) {
      resize.unobserve(marker.element);
    }
    marker.element = anchor.element;
    marker.point = anchor.point;
    resize.observe(anchor.element);
    marker.node.className = number === undefined ? "marker pending" : "marker";
    marker.node.textContent = number === undefined ? "" : String(number);
    marker.node.setAttribute(
      "aria-label",
      number === undefined ? "New annotation" : `Annotation ${number}`,
    );
    schedule();
  }
  function remove(id: string): void {
    const marker = markers.get(id);
    if (!marker) return;
    markers.delete(id);
    marker.node.remove();
    if (![...markers.values()].some((other) => other.element === marker.element))
      resize.unobserve(marker.element);
  }
  return {
    set,
    remove,
    position,
    schedule,
    has: (id: string) => markers.has(id),
    anchor: (id: string): Anchor | undefined => markers.get(id),
    hidden(value: boolean): void {
      container.classList.toggle("hidden", value);
    },
    /** Run after each position pass, so the outline and editor follow in the same frame. */
    onUpdate(listener: () => void): void {
      afterUpdate = listener;
    },
    clear(): void {
      for (const id of markers.keys()) remove(id);
    },
    dispose(): void {
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      container.remove();
      markers.clear();
    },
  };
}
export type Markers = ReturnType<typeof createMarkers>;

function noop(): void {}

/** Nearest ancestor that can scroll in the wheel's direction, the document's scroller last. */
function scrollable(start: Element | null, deltaX: number, deltaY: number): Element | null {
  for (let node = start; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const canY =
      deltaY !== 0 &&
      /(auto|scroll)/.test(style.overflowY) &&
      node.scrollHeight > node.clientHeight;
    const canX =
      deltaX !== 0 && /(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth;
    if (canY || canX) return node;
  }
  return document.scrollingElement;
}
