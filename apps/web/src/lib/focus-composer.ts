/** The thread composer's message box, once it can take the caret. */
const composerInput = '[data-slot="composer"] [role="combobox"][contenteditable="true"]';
/** A sheet or modal still on screen (closing included): it hands focus back as it goes. */
const overlay = '[role="dialog"], [role="alertdialog"]';

/**
 * Put the caret in the thread's message box once a launcher that opened the thread (the palette,
 * search) has gone and the composer is on screen, so the person can type at once. Looks again
 * on each frame for a moment; a key or a click meanwhile means the person has chosen where to
 * be, and it stops. Returns a cancel.
 */
export function focusComposerSoon(doc: Document = document, frames = 90): () => void {
  let left = frames;
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    doc.removeEventListener("pointerdown", stop, true);
    doc.removeEventListener("keydown", stop, true);
  };
  const look = () => {
    const input = doc.querySelector<HTMLElement>(composerInput);
    if (input && !doc.querySelector(overlay) && !input.closest('[inert], [aria-hidden="true"]')) {
      stop();
      input.focus({ preventScroll: true });
      return;
    }
    if (--left > 0) frame = requestAnimationFrame(look);
    else stop();
  };
  doc.addEventListener("pointerdown", stop, true);
  doc.addEventListener("keydown", stop, true);
  frame = requestAnimationFrame(look);
  return stop;
}
