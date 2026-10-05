/** Desktop widths put the caret in the composer when a thread opens; a phone's keyboard waits. */
export function wideEnoughToFocus(): boolean {
  return typeof matchMedia === "function" && matchMedia("(min-width: 768px)").matches;
}

/**
 * Focus the first option of the open request the agent is asking (an approval, a question)
 * once its card has rendered. Cards load after the transcript paints, so this looks again on
 * each frame for a moment. Returns a cancel.
 */
export function focusOpenRequest(root: Element, tries = 60): () => void {
  let frame = 0;
  let left = tries;
  const look = () => {
    const cards = root.querySelectorAll("article[aria-label]");
    for (let index = cards.length - 1; index >= 0; index--) {
      const option = cards[index]?.querySelector<HTMLElement>(
        "button:not([disabled]):not([aria-disabled='true']), [role='radio'], input",
      );
      if (option) {
        option.focus();
        return;
      }
    }
    if (--left > 0) frame = requestAnimationFrame(look);
  };
  frame = requestAnimationFrame(look);
  return () => cancelAnimationFrame(frame);
}
