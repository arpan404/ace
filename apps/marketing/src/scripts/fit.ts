/*
 * Scales each fixed-size drawing (components/site/Fit.astro) to its box's width, and again
 * whenever the box changes size, in browsers whose CSS can't work the scale out itself.
 */

export function startFit(boxes: Iterable<HTMLElement>): void {
  if (CSS.supports("scale", "calc(100cqw / 1px)")) return;
  const fit = (box: HTMLElement) => {
    const drawn = Number(box.dataset.fit);
    if (drawn > 0) box.style.setProperty("--fit", String(box.clientWidth / drawn));
    box.dataset.fitted = "";
  };
  const watcher = new ResizeObserver((entries) => {
    for (const entry of entries) if (entry.target instanceof HTMLElement) fit(entry.target);
  });
  for (const box of boxes) {
    fit(box);
    watcher.observe(box);
  }
}
