import {
  sceneGlassRectsMax,
  type SceneGlassRect,
  type SceneHostMessage,
} from "@ace/protocol/suits";

/*
 * ace's glass over the app scene (ADR 0150, "Scenes"). The scene runs in a sandboxed,
 * out-of-process frame, and a browser's `backdrop-filter` can't reach into it: the sidebar,
 * the right panel, the composer and every menu or popover would show the scene sharp behind
 * their text. So the host tells the scene runtime where its glass is (`glass`), and the runtime
 * draws the scene blurred inside those rectangles itself. The glass here keeps its tint and edge.
 */

/** A pane of glass as measured on the page, in viewport CSS px. */
export interface GlassPane {
  left: number;
  top: number;
  width: number;
  height: number;
  radius: number;
  blur: number;
  saturate: number;
}

/** The scene frame's box, in viewport CSS px. */
export interface FrameBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

const half = (value: number) => Math.round(value * 2) / 2;

/**
 * The `glass` rectangles for these panes over this frame: in the frame's own CSS px, corners no
 * rounder than the pane allows, panes that are empty or wholly outside the frame dropped, and at
 * most the protocol's limit, keeping the largest. Values are rounded to half a pixel, so a layout
 * that didn't really move sends the same list. Pure.
 */
export function sceneGlass(panes: readonly GlassPane[], frame: FrameBox): SceneGlassRect[] {
  const inside = panes.filter(
    (pane) =>
      pane.width > 0 &&
      pane.height > 0 &&
      pane.left < frame.left + frame.width &&
      pane.top < frame.top + frame.height &&
      pane.left + pane.width > frame.left &&
      pane.top + pane.height > frame.top,
  );
  const kept =
    inside.length <= sceneGlassRectsMax
      ? inside
      : inside
          .toSorted((a, b) => b.width * b.height - a.width * a.height)
          .slice(0, sceneGlassRectsMax);
  return inside
    .filter((pane) => kept.includes(pane))
    .map((pane) => ({
      x: half(pane.left - frame.left),
      y: half(pane.top - frame.top),
      width: half(pane.width),
      height: half(pane.height),
      radius: half(Math.max(0, Math.min(pane.radius, pane.width / 2, pane.height / 2))),
      blur: Math.min(64, Math.max(0, pane.blur)),
      saturate: Math.min(4, Math.max(0, pane.saturate)),
    }));
}

/** The blur (CSS px) and saturation a computed `backdrop-filter` asks for, where it says. */
export function glassFilter(filter: string): { blur?: number; saturate?: number } {
  const blur = /blur\(\s*([\d.]+)px\s*\)/.exec(filter)?.[1];
  const saturate = /saturate\(\s*([\d.]+)(%?)\s*\)/.exec(filter);
  return {
    ...(blur !== undefined && { blur: Number(blur) }),
    ...(saturate?.[1] !== undefined && {
      saturate: Number(saturate[1]) / (saturate[2] === "%" ? 100 : 1),
    }),
  };
}

/**
 * What counts as glass over the app scene: the regions the scene shows through and every floating
 * layer. A match inside another match is skipped, so glass is never stacked on glass.
 */
export const sceneGlassSelector = [
  '[data-part="sidebar"]',
  '[data-part="right-panel"]',
  '[data-part="composer"]',
  ".ace-floating",
  ".ace-glass-dock",
  ".glass",
].join(",");

/** The glass's blur where a pane has no backdrop filter of its own (the regions). */
const defaultBlur = 24;

function measure(element: Element, fallback: { blur: number; saturate: number }): GlassPane {
  const box = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const own = glassFilter(
    style.backdropFilter || style.getPropertyValue("-webkit-backdrop-filter"),
  );
  return {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    radius: Number.parseFloat(style.borderTopLeftRadius) || 0,
    blur: own.blur ?? fallback.blur,
    saturate: own.saturate ?? fallback.saturate,
  };
}

/**
 * Keeps the scene frame told where ace's glass is: measured at most once a frame, after a
 * resize, a layer mounting (menus and popovers portal into <body>) or a transition ending, and
 * sent only when it changed. Returns the stop.
 */
export function watchSceneGlass(
  frame: HTMLIFrameElement,
  post: (message: SceneHostMessage) => void,
): () => void {
  let queued = 0;
  let last = "";
  const watched = new Set<Element>();
  const sizes =
    typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => queue());

  function scan() {
    queued = 0;
    const root = getComputedStyle(document.documentElement);
    const fallback = {
      blur: Number.parseFloat(root.getPropertyValue("--glass-blur")) || defaultBlur,
      saturate: Number.parseFloat(root.getPropertyValue("--glass-saturate")) || 1,
    };
    const matches = [...document.querySelectorAll(sceneGlassSelector)];
    const outermost = matches.filter(
      (element) => !matches.some((other) => other !== element && other.contains(element)),
    );
    for (const element of outermost)
      if (!watched.has(element)) {
        watched.add(element);
        sizes?.observe(element);
      }
    for (const element of watched)
      if (!element.isConnected) {
        watched.delete(element);
        sizes?.unobserve(element);
      }
    const rects = sceneGlass(
      outermost.map((element) => measure(element, fallback)),
      frame.getBoundingClientRect(),
    );
    const key = JSON.stringify(rects);
    if (key === last) return;
    last = key;
    post({ type: "glass", rects });
  }
  function queue() {
    if (queued === 0) queued = requestAnimationFrame(scan);
  }

  const mounts = new MutationObserver(queue);
  mounts.observe(document.body, { childList: true });
  window.addEventListener("resize", queue);
  document.addEventListener("transitionend", queue, true);
  document.addEventListener("animationend", queue, true);
  queue();
  return () => {
    if (queued !== 0) cancelAnimationFrame(queued);
    mounts.disconnect();
    sizes?.disconnect();
    window.removeEventListener("resize", queue);
    document.removeEventListener("transitionend", queue, true);
    document.removeEventListener("animationend", queue, true);
  };
}
