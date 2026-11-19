/*
 * Scales each fixed-size drawing (components/site/Fit.astro) to its box's width, and again
 * whenever the box changes size, in browsers whose CSS can't work the scale out itself.
 */

/** Sets one box's scale from its width and the width its drawing was made at. */
function fit(box: HTMLElement): void {
  const drawn = Number(box.dataset.fit);
  if (drawn > 0) box.style.setProperty("--fit", String(box.clientWidth / drawn));
  box.dataset.fitted = "";
}

export function startFit(boxes: Iterable<HTMLElement>): void {
  if (CSS.supports("scale", "calc(100cqw / 1px)")) return;
  const watcher = new ResizeObserver((entries) => {
    for (const entry of entries) if (entry.target instanceof HTMLElement) fit(entry.target);
  });
  for (const box of boxes) {
    fit(box);
    watcher.observe(box);
  }
}
