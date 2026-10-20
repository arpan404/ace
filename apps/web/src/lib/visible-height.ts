/**
 * The height left visible above the on-screen keyboard, in CSS pixels, or undefined when no
 * keyboard covers the page. Chrome and Android shrink the layout itself
 * (`interactive-widget=resizes-content` in index.html), so the visual viewport matches it and
 * this stays undefined; iOS lays the keyboard over the page and only shrinks the visual
 * viewport. A pinch zoom also shrinks it, so a zoomed page is not mistaken for a keyboard.
 */
export function visibleHeight(
  layoutHeight: number,
  visual: { height: number; scale: number },
): number | undefined {
  const keyboard = Math.abs(visual.scale - 1) < 0.01 && layoutHeight - visual.height > 80;
  return keyboard ? Math.round(visual.height) : undefined;
}

/**
 * Keeps `--visible-height` on `root` equal to the height above the keyboard while one is open,
 * so the app shell can end above it with `var(--visible-height, 100dvh)`. Returns a stop.
 */
export function watchVisibleHeight(
  win: Pick<Window, "innerHeight" | "visualViewport">,
  root: HTMLElement,
): () => void {
  const visual = win.visualViewport;
  if (!visual) return () => {};
  let last: number | undefined | null = null;
  const update = () => {
    const height = visibleHeight(win.innerHeight, visual);
    if (height === last) return;
    last = height;
    if (height === undefined) root.style.removeProperty("--visible-height");
    else root.style.setProperty("--visible-height", `${height}px`);
  };
  visual.addEventListener("resize", update);
  visual.addEventListener("scroll", update);
  update();
  return () => {
    visual.removeEventListener("resize", update);
    visual.removeEventListener("scroll", update);
  };
}
