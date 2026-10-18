import type { CursorInit, CursorOp, CursorPoint, CursorStyle } from "../cursor-init.ts";
import { h, place } from "../overlay/dom.ts";
import { createHost } from "../overlay/host.ts";
import { randomId } from "../overlay/id.ts";
import { cursorSheet, maskSheet } from "./sheet.ts";

export interface CursorHandle {
  documentId: string;
  apply(op: CursorOp): void;
  /** Resolves once a hidden layer and the mask have reached the screen (two frames). */
  settled(): Promise<void>;
  host(): HTMLElement;
  teardown(): void;
}

const svgNs = "http://www.w3.org/2000/svg";
/** A cue stays on the page this long after its last change. */
const cueMs = 900;

function svg(tag: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(svgNs, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

function nextFrames(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    // Hidden or throttled documents may never paint; a capture must not wait for them.
    setTimeout(finish, 120);
  });
}

/** Adopts the mask into this document and every same-origin frame below it. */
function maskDocuments(selector: string): () => void {
  const undo: (() => void)[] = [];
  const visit = (view: Window, depth: number) => {
    try {
      const doc = view.document;
      // A frame's document adopts only sheets built by its own constructor.
      const Sheet = (view as Window & { CSSStyleSheet: typeof CSSStyleSheet }).CSSStyleSheet;
      const own = maskSheet(selector, Sheet);
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, own];
      undo.push(() => {
        doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((entry) => entry !== own);
      });
    } catch {
      return; // A cross-origin frame: out of this world's reach.
    }
    if (depth >= 8) return;
    for (let index = 0; index < view.frames.length; index++) {
      const child = view.frames[index];
      if (child) visit(child, depth + 1);
    }
  };
  visit(window, 0);
  return () => {
    for (const step of undo) step();
  };
}

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** An arrow showing which way an agent scrolls. */
function scrollArrow(dx: number, dy: number): HTMLElement {
  const node = h("div", { class: "scroll" });
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const icon = svg("svg", { width: "12", height: "12", viewBox: "0 0 12 12" });
  icon.append(
    svg("path", {
      d: "M2.5 6h7M6.5 3l3 3-3 3",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.6",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      transform: `rotate(${angle.toFixed(1)} 6 6)`,
    }),
  );
  node.append(icon);
  return node;
}

interface Drawn {
  root: HTMLElement;
  label: HTMLElement;
  at: CursorPoint;
}

/**
 * Agent cursors drawn in the page (ADR 0082, agent cursor): one Pebble per agent gliding to
 * where it acts, with short cues for clicks, typing, scrolling and drags. Nothing here takes
 * input; the layer never intercepts the page.
 */
export function startCursor(init: CursorInit): CursorHandle {
  const sheet = cursorSheet(init);
  const overlay = createHost(sheet, "ace-agent-cursor");
  const layer = overlay.layer;
  place(layer, { "--glide": `${init.glideMs}ms` });
  const agents = new Map<string, Drawn>();
  const cues = new Map<string, { node: HTMLElement | SVGElement; timer: number }>();
  let unmask: (() => void) | undefined;

  const setStyle = (style: CursorStyle) =>
    place(layer, { "--fill": style.fill, "--outline": style.outline });
  setStyle(init.style);

  const pebble = () => {
    const { tip, path, outline } = init.glyph;
    const node = svg("svg", {
      class: "pebble",
      width: "22",
      height: "22",
      viewBox: "0 0 24 24",
      "aria-hidden": "true",
    });
    // The tip sits on the point the agent acts at.
    place(node, {
      left: `${(-tip.x * 22) / 24}px`,
      top: `${(-tip.y * 22) / 24}px`,
    });
    node.append(
      svg("path", {
        d: path,
        fill: "var(--fill)",
        stroke: "var(--outline)",
        "stroke-width": String(outline),
        "stroke-linejoin": "round",
      }),
    );
    return node;
  };

  const move = (drawn: Drawn, at: CursorPoint) => {
    drawn.at = at;
    place(drawn.root, { transform: `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)` });
  };

  const cue = (key: string, node: HTMLElement | SVGElement, life = cueMs) => {
    const before = cues.get(key);
    if (before) {
      clearTimeout(before.timer);
      if (before.node !== node) before.node.remove();
    }
    if (!node.isConnected) layer.append(node);
    const timer = window.setTimeout(() => {
      cues.delete(key);
      node.remove();
    }, life);
    cues.set(key, { node, timer });
  };

  const pulse = (at: CursorPoint) => {
    const ring = h("div", { class: "pulse" });
    place(ring, { transform: `translate(${at.x}px, ${at.y}px)` });
    layer.append(ring);
    const animation = ring.animate(
      reduced()
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [
            { transform: `translate(${at.x}px, ${at.y}px) scale(0.4)`, opacity: 1 },
            { transform: `translate(${at.x}px, ${at.y}px) scale(1.6)`, opacity: 0 },
          ],
      { duration: init.motion.standard * 2, easing: "ease-out" },
    );
    animation.onfinish = () => ring.remove();
  };

  const apply = (op: CursorOp) => {
    switch (op.op) {
      case "style":
        setStyle(op.style);
        return;
      case "person":
        layer.classList.toggle("person", op.active);
        return;
      case "capture":
        layer.classList.toggle("capture", op.hidden);
        if (op.mask && !unmask) unmask = maskDocuments(init.secretSelector);
        if (!op.mask && unmask) {
          unmask();
          unmask = undefined;
        }
        return;
      case "agent": {
        let drawn = agents.get(op.id);
        if (!drawn) {
          const root = h("div", { class: "agent" });
          const label = h("div", { class: "name" });
          root.append(pebble(), label);
          drawn = { root, label, at: op.at };
          agents.set(op.id, drawn);
          // A new cursor appears where it is; it glides only from then on.
          place(root, { transition: "none" });
          move(drawn, op.at);
          layer.append(root);
          void root.offsetWidth;
          root.style.removeProperty("transition");
        }
        drawn.root.classList.remove("leaving");
        drawn.label.textContent = op.name;
        if (!op.glide) place(drawn.root, { transition: "none" });
        move(drawn, op.at);
        if (!op.glide) {
          void drawn.root.offsetWidth;
          drawn.root.style.removeProperty("transition");
        }
        return;
      }
      case "leave": {
        const drawn = agents.get(op.id);
        if (!drawn) return;
        agents.delete(op.id);
        drawn.root.classList.add("leaving");
        window.setTimeout(() => drawn.root.remove(), init.motion.standard);
        return;
      }
      case "click": {
        const drawn = agents.get(op.id);
        if (drawn) pulse(drawn.at);
        return;
      }
      case "type": {
        const node = cues.get(`type:${op.id}`)?.node ?? h("div", { class: "field" });
        place(node, {
          transform: `translate(${op.field.x}px, ${op.field.y}px)`,
          width: `${Math.max(4, op.field.width)}px`,
          height: `${Math.max(4, op.field.height)}px`,
        });
        cue(`type:${op.id}`, node);
        return;
      }
      case "scroll": {
        const drawn = agents.get(op.id);
        const at = drawn?.at ?? { x: innerWidth / 2, y: innerHeight / 2 };
        const node = scrollArrow(op.dx, op.dy);
        place(node, { transform: `translate(${at.x + 26}px, ${at.y + 6}px)` });
        cue(`scroll:${op.id}`, node, cueMs / 1.5);
        return;
      }
      case "drag": {
        const trail = svg("svg", {
          class: "trail",
          width: String(innerWidth),
          height: String(innerHeight),
        });
        trail.append(
          svg("line", {
            x1: String(op.from.x),
            y1: String(op.from.y),
            x2: String(op.to.x),
            y2: String(op.to.y),
            stroke: "var(--fill)",
            "stroke-width": "2",
            "stroke-dasharray": "4 4",
            "stroke-linecap": "round",
          }),
          svg("circle", {
            cx: String(op.from.x),
            cy: String(op.from.y),
            r: "4",
            fill: "var(--fill)",
            stroke: "var(--outline)",
            "stroke-width": "1.5",
          }),
        );
        cue(`drag:${op.id}`, trail, cueMs + init.glideMs);
        return;
      }
    }
  };

  return {
    documentId: randomId(),
    apply,
    settled: nextFrames,
    host: () => overlay.host,
    teardown() {
      unmask?.();
      for (const entry of cues.values()) clearTimeout(entry.timer);
      overlay.dispose();
    },
  };
}
