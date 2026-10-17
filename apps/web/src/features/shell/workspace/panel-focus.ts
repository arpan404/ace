import { useLayoutEffect, useRef, type FocusEvent, type RefObject } from "react";
import { findComposerInput } from "@/lib/focus-composer.ts";

const focusable =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** Whether `element` is displayed: no ancestor up to the document is `display: none`. */
function displayed(element: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hidden || view?.getComputedStyle(node).display === "none") return false;
  }
  return true;
}

/** Where focus lands in the panel: the showing tab, else its first control. */
function panelStop(panel: HTMLElement): HTMLElement | null {
  return (
    panel.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
    panel.querySelector<HTMLElement>(focusable)
  );
}

/**
 * After a shortcut opened the side panel or showed one of its tools, move focus into it (the
 * showing tab) once it is on screen, so the keyboard carries on there. Looks on each frame for
 * a moment; a key or a click meanwhile, a dialog opening (a tool's own palette) or focus already
 * inside the panel (a terminal taking it) leaves focus where it is. The floating panel is a
 * sheet, which moves focus itself. Returns a cancel.
 */
export function focusPanelSoon(root: HTMLElement | null, frames = 30): () => void {
  if (!root) return () => {};
  const doc = root.ownerDocument;
  let left = frames;
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    doc.removeEventListener("pointerdown", stop, true);
    doc.removeEventListener("keydown", stop, true);
  };
  const look = () => {
    const panel = root.querySelector<HTMLElement>("[data-panel]");
    // Toasts are dialogs too, but never hold focus on their own.
    const dialog = [...doc.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some(
      (each) => !each.closest('[data-slot="toast-viewport"]'),
    );
    if (dialog) return stop();
    if (panel && displayed(panel)) {
      if (!panel.contains(doc.activeElement)) panelStop(panel)?.focus({ preventScroll: true });
      return stop();
    }
    if (--left > 0) frame = requestAnimationFrame(look);
    else stop();
  };
  doc.addEventListener("pointerdown", stop, true);
  doc.addEventListener("keydown", stop, true);
  frame = requestAnimationFrame(look);
  return stop;
}

/**
 * Hiding the side panel while focus is in it hands focus back to the composer (else to
 * `fallback`, the panel's toggle), never to the page's body. Returns the focus handlers for the
 * panel's root.
 */
export function useFocusBackOnHide(
  panel: RefObject<HTMLElement | null>,
  open: boolean,
  fallback: () => HTMLElement | null | false | undefined,
) {
  // Focus went into the panel and has not moved on to anything outside it since. Leaving for
  // nowhere (a control hiding under it) still counts as inside.
  const inside = useRef(false);
  const wasOpen = useRef(open);
  const latest = useRef(fallback);
  useLayoutEffect(() => {
    latest.current = fallback;
  });
  useLayoutEffect(() => {
    const was = wasOpen.current;
    wasOpen.current = open;
    if (!was || open || !inside.current) return;
    inside.current = false;
    const element = panel.current;
    const doc = element?.ownerDocument ?? document;
    const active = doc.activeElement;
    // The person moved focus elsewhere on purpose (a menu, a dialog): leave it there.
    if (active && active !== doc.body && !element?.contains(active)) return;
    const target = findComposerInput(doc) ?? (latest.current() || undefined);
    target?.focus({ preventScroll: true });
  }, [open, panel]);
  return {
    onFocus: () => {
      inside.current = true;
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      const next = event.relatedTarget;
      if (next instanceof Node && !event.currentTarget.contains(next)) inside.current = false;
    },
  };
}
