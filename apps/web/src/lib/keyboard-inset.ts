/**
 * How much of the layout viewport the on-screen keyboard covers, in CSS pixels. Chrome and
 * Android shrink the layout itself (`interactive-widget=resizes-content` in index.html), so
 * this stays 0 there; iOS Safari only shrinks the visual viewport, which this measures.
 */
export function keyboardInset(
  layoutHeight: number,
  visual: { height: number; offsetTop: number },
): number {
  return Math.max(0, Math.round(layoutHeight - visual.height - visual.offsetTop));
}

/**
 * Keeps `--kb-inset` on `root` equal to the keyboard's height, so bottom-pinned UI (the
 * composer, toasts) can stand above it with `calc(… + var(--kb-inset, 0px))`. Returns a stop.
 */
export function watchKeyboardInset(
  win: Pick<Window, "innerHeight" | "visualViewport">,
  root: HTMLElement,
): () => void {
  const visual = win.visualViewport;
  if (!visual) return () => {};
  let last = -1;
  const update = () => {
    const inset = keyboardInset(win.innerHeight, visual);
    if (inset === last) return;
    last = inset;
    if (inset > 0) root.style.setProperty("--kb-inset", `${inset}px`);
    else root.style.removeProperty("--kb-inset");
  };
  visual.addEventListener("resize", update);
  visual.addEventListener("scroll", update);
  update();
  return () => {
    visual.removeEventListener("resize", update);
    visual.removeEventListener("scroll", update);
  };
}
