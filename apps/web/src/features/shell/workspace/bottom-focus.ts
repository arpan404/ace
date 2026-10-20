import { useLayoutEffect, useRef, type FocusEvent, type RefObject } from "react";
import { findComposerInput } from "@/lib/focus-composer.ts";

/** What takes the keyboard in a shown tab: a terminal's input, else the selected tab. */
function stop(panel: HTMLElement): HTMLElement | null {
  return (
    panel.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden]) textarea:not([disabled])') ??
    panel.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
  );
}

/**
 * Focus the bottom panel's terminal once it is on screen (its view loads after the panel).
 * Looks on each frame for a moment; a key or a click meanwhile leaves focus where it is.
 * Returns a cancel.
 */
function focusSoon(panel: HTMLElement, frames = 60): () => void {
  const doc = panel.ownerDocument;
  let left = frames;
  let frame = 0;
  const cancel = () => {
    cancelAnimationFrame(frame);
    doc.removeEventListener("pointerdown", cancel, true);
    doc.removeEventListener("keydown", cancel, true);
  };
  const look = () => {
    const input = panel.querySelector<HTMLElement>(
      '[role="tabpanel"]:not([hidden]) textarea:not([disabled])',
    );
    // Until the terminal's input exists, the selected tab holds focus; then the input does.
    if (!panel.contains(doc.activeElement) || (input && doc.activeElement !== input))
      stop(panel)?.focus({ preventScroll: true });
    if (input || --left <= 0) return cancel();
    frame = requestAnimationFrame(look);
  };
  doc.addEventListener("pointerdown", cancel, true);
  doc.addEventListener("keydown", cancel, true);
  frame = requestAnimationFrame(look);
  return cancel;
}

/**
 * The bottom panel takes focus when it shows (its terminal, ready to type) and gives it back
 * when it hides: to what had it before it showed, else the composer. Focus the person moved
 * elsewhere meanwhile (a menu, a dialog) stays there. Call outside the panel's hidden Activity,
 * which pauses effects inside it. Returns the focus handlers for the panel's root.
 */
export function useBottomFocus(panel: RefObject<HTMLElement | null>, open: boolean) {
  const inside = useRef(false);
  const wasOpen = useRef(open);
  const before = useRef<HTMLElement | null>(null);
  // Hidden in an Activity, the ref is detached by the time the hide is seen.
  const seen = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (panel.current) seen.current = panel.current;
  });
  useLayoutEffect(() => {
    const was = wasOpen.current;
    wasOpen.current = open;
    if (was === open) return;
    const element = panel.current ?? seen.current;
    const doc = element?.ownerDocument ?? document;
    const active = doc.activeElement;
    if (open) {
      before.current =
        active instanceof HTMLElement && active !== doc.body && !element?.contains(active)
          ? active
          : null;
      return element ? focusSoon(element) : undefined;
    }
    if (!inside.current) return;
    inside.current = false;
    if (active && active !== doc.body && !element?.contains(active)) return;
    const back = before.current;
    before.current = null;
    const target = back?.isConnected && !back.closest("[hidden], [inert]") ? back : undefined;
    (target ?? findComposerInput(doc))?.focus({ preventScroll: true });
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
