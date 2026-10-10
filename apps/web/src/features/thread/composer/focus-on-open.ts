/**
 * Focus Deny for a deliberate approval, otherwise the first answer to the open request
 * once its card has rendered. Cards load after the transcript paints, so this looks again on
 * each frame for a moment. Returns a cancel.
 */
export function focusOpenRequest(root: Element, tries = 60): () => void {
  let frame = 0;
  let left = tries;
  let release: (() => void) | undefined;
  const focus = (element: HTMLElement) => {
    element.setAttribute("data-auto-focused", "");
    const clear = () => {
      element.removeAttribute("data-auto-focused");
      element.ownerDocument.removeEventListener("keydown", clear, true);
      element.removeEventListener("blur", clear);
    };
    element.ownerDocument.addEventListener("keydown", clear, { capture: true, once: true });
    element.addEventListener("blur", clear, { once: true });
    release = clear;
    element.focus({ preventScroll: true });
  };
  const look = () => {
    const cards = root.querySelectorAll<HTMLElement>("article[aria-label]");
    for (let index = cards.length - 1; index >= 0; index--) {
      // An answer first (a numbered choice, an option, a field), never the card's own chrome
      // such as its pager; any other button only when it has none.
      const card = cards[index];
      if (card?.querySelector("[data-approval-deliberate]")) {
        const deny = card.querySelector<HTMLElement>(
          "[data-approval-refusal]:not([disabled]):not([aria-disabled='true'])",
        );
        if (!deny) card.setAttribute("tabindex", "-1");
        focus(deny ?? card);
        return;
      }
      const option =
        card?.querySelector<HTMLElement>(
          "button[aria-keyshortcuts]:not([disabled]):not([aria-disabled='true']), [role='radio'], input",
        ) ??
        card?.querySelector<HTMLElement>(
          "button:not([disabled]):not([aria-disabled='true']):not([data-slot='icon-button'])",
        );
      if (option) {
        // The card sits above the composer, in view; scrolling to it mid-rise would drag the
        // whole shell up with it.
        focus(option);
        return;
      }
    }
    if (--left > 0) frame = requestAnimationFrame(look);
  };
  frame = requestAnimationFrame(look);
  return () => {
    cancelAnimationFrame(frame);
    release?.();
  };
}
