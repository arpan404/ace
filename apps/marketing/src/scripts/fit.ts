/*
 * Scales each fixed-size drawing (components/site/Fit.astro) to its box's width, and again
 * whenever the box changes size.
 */

export function startFit(boxes: Iterable<HTMLElement>): void {
  const fit = (box: HTMLElement) => {
    const drawn = Number(box.dataset.fit);
    if (drawn > 0) box.style.setProperty("--fit", String(box.clientWidth / drawn));
  };
  const watcher = new ResizeObserver((entries) => {
    for (const entry of entries) if (entry.target instanceof HTMLElement) fit(entry.target);
  });
  for (const box of boxes) {
    fit(box);
    watcher.observe(box);
  }
}
