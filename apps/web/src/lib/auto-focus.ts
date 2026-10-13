/**
 * Marks `element`, which is about to take focus on the person's behalf (a dialog opening, a
 * request card arriving), `data-auto-focused` until they press a key or focus moves on, so it
 * shows a quieter ring than focus they moved themselves (styles/index.css `focus-ring`). Returns
 * a release that clears the mark early.
 */
export function markAutoFocused(element: HTMLElement): () => void {
  element.setAttribute("data-auto-focused", "");
  const clear = () => {
    element.removeAttribute("data-auto-focused");
    element.ownerDocument.removeEventListener("keydown", clear, true);
    element.removeEventListener("blur", clear);
  };
  element.ownerDocument.addEventListener("keydown", clear, { capture: true, once: true });
  element.addEventListener("blur", clear, { once: true });
  return clear;
}

/** Focuses `element` on the person's behalf, marked as `markAutoFocused` describes. */
export function focusOnBehalf(element: HTMLElement): () => void {
  const clear = markAutoFocused(element);
  element.focus({ preventScroll: true });
  return clear;
}
