import { nextFrame } from "./next-frame.ts";

/*
 * What is drawn over the app from outside its root: menus, popovers, dialogs, sheets, toasts
 * and tooltips all render through portals into <body>. Something native laid over the page
 * (the desktop's embedded browser view) would hide them, so it steps aside while one is over it.
 */

const inert = new Set(["SCRIPT", "STYLE", "TEMPLATE", "LINK", "NOSCRIPT"]);
/** Portals nest their visible box a few levels down (portal → positioner → popup). */
const maxDepth = 4;

/** <body>'s children other than the one holding `under` (the app itself). */
function overlayRoots(under: Element): Element[] {
  const body = under.ownerDocument.body;
  return [...body.children].filter((child) => !child.contains(under) && !inert.has(child.tagName));
}

/**
 * The boxes drawn over the app that holds `under` right now. The first element with a size on
 * each path stands for what is under it, so a dialog's backdrop or a menu's positioner is one
 * box.
 */
export function overlayBoxes(under: Element): DOMRectReadOnly[] {
  const boxes: DOMRectReadOnly[] = [];
  const visit = (element: Element, depth: number) => {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      boxes.push(rect);
      return;
    }
    if (depth < maxDepth) for (const child of element.children) visit(child, depth + 1);
  };
  for (const root of overlayRoots(under)) visit(root, 0);
  return boxes;
}

/**
 * Calls back (once per frame at most) whenever something drawn over the app may have
 * appeared, moved or gone. Only <body>'s own children and the overlays' subtrees are watched,
 * never the app's root, so the app's own rendering costs nothing here.
 */
export function observeOverlays(under: Element, onChange: () => void): () => void {
  if (typeof MutationObserver === "undefined") return () => {};
  let cancel: (() => void) | undefined;
  const schedule = () => {
    cancel ??= nextFrame(() => {
      cancel = undefined;
      onChange();
    });
  };
  const inside = new MutationObserver(schedule);
  const watchRoots = () => {
    inside.disconnect();
    for (const root of overlayRoots(under))
      inside.observe(root, { childList: true, subtree: true, attributes: true });
  };
  const top = new MutationObserver(() => {
    watchRoots();
    schedule();
  });
  top.observe(under.ownerDocument.body, { childList: true });
  watchRoots();
  return () => {
    top.disconnect();
    inside.disconnect();
    cancel?.();
  };
}
