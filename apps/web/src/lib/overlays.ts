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
    // Base UI's transparent pointer guard spans the viewport around a menu. It is
    // an input shield, not a painted backdrop; only the popup needs native clearance.
    if (element.hasAttribute("data-base-ui-focus-guard")) return;
    if (element.hasAttribute("data-base-ui-inert") && element.childElementCount === 0) {
      const style = element.ownerDocument.defaultView?.getComputedStyle(element);
      if (
        style?.clipPath &&
        style.clipPath !== "none" &&
        style.backgroundColor === "rgba(0, 0, 0, 0)"
      )
        return;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      boxes.push(rect);
      return;
    }
    if (depth < maxDepth) for (const child of element.children) visit(child, depth + 1);
  };
  for (const root of overlayRoots(under)) visit(root, 0);
  for (const inline of under.ownerDocument.querySelectorAll("[data-native-overlay]"))
    visit(inline, 0);
  return boxes;
}

/**
 * Calls back (once per frame at most) whenever something drawn over the app may have
 * appeared, moved or gone. Portal subtrees are watched directly; changes in the app
 * only matter when they add or remove an explicitly marked inline overlay.
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
    for (const root of [
      ...overlayRoots(under),
      ...under.ownerDocument.querySelectorAll("[data-native-overlay]"),
    ])
      inside.observe(root, { childList: true, subtree: true, attributes: true });
  };
  const top = new MutationObserver(() => {
    watchRoots();
    schedule();
  });
  top.observe(under.ownerDocument.body, { childList: true });
  const inline = new MutationObserver((records) => {
    if (
      !records.some((record) =>
        [...record.addedNodes, ...record.removedNodes].some(
          (node) =>
            node instanceof Element &&
            (node.matches("[data-native-overlay]") || node.querySelector("[data-native-overlay]")),
        ),
      )
    )
      return;
    watchRoots();
    schedule();
  });
  const app = under.ownerDocument.body.children;
  for (const root of app)
    if (root.contains(under)) inline.observe(root, { childList: true, subtree: true });
  watchRoots();
  return () => {
    inline.disconnect();
    top.disconnect();
    inside.disconnect();
    cancel?.();
  };
}
