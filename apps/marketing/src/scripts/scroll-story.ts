/*
 * Drives an inner page's story (components/site/ScrollStory.astro): the step crossing the
 * reading line becomes the current one. The root's `data-step` and the `scrollstory:step` event
 * tell the drawing which step that is. A tour's index marks the current step and jumps to one.
 */

/** The event a story fires when its current step changes; `detail` is the step's index. */
export const stepEvent = "scrollstory:step";

/**
 * Where on screen a step becomes current, from the top: the middle of the screen, or, when the
 * stage is pinned across the top (a phone), the middle of what is left under it.
 */
export function readingLine(viewport: number, stageBottom: number): number {
  return stageBottom > 0 && stageBottom < viewport ? (stageBottom + viewport) / 2 : viewport / 2;
}

/** The sideways scroll that puts an item in the middle of a row, kept within the row's ends. */
export function centredScroll(
  item: { left: number; width: number },
  row: { width: number; scrollWidth: number },
): number {
  const wanted = item.left + item.width / 2 - row.width / 2;
  return Math.max(0, Math.min(row.scrollWidth - row.width, wanted));
}

export function startScrollStory(root: HTMLElement): void {
  const steps = [...root.querySelectorAll<HTMLElement>("[data-scroll-step]")];
  if (steps.length === 0) return;
  const pin = root.querySelector<HTMLElement>(".pin");
  const row = root.querySelector<HTMLElement>("[data-scroll-index]");
  const jumps = [...root.querySelectorAll<HTMLAnchorElement>("[data-scroll-jump]")];
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  root.dataset.live = "";

  let current = 0;
  let holding = false;
  const show = (index: number) => {
    if (index < 0 || index === current) return;
    current = index;
    root.dataset.step = String(index);
    steps.forEach((step, at) => step.classList.toggle("on", at === index));
    jumps.forEach((jump, at) => {
      if (at === index) jump.setAttribute("aria-current", "step");
      else jump.removeAttribute("aria-current");
    });
    const mark = jumps[index];
    // The row scrolls sideways only; moving the page here would fight the reader's scroll.
    if (row && mark && row.scrollWidth > row.clientWidth) {
      const left = centredScroll(
        { left: mark.offsetLeft, width: mark.offsetWidth },
        { width: row.clientWidth, scrollWidth: row.scrollWidth },
      );
      row.scrollTo({ left, behavior: still ? "auto" : "smooth" });
    }
    root.dispatchEvent(new CustomEvent<number>(stepEvent, { detail: index }));
  };

  /** How far down the stage reaches when it is pinned across the top, above the steps; else 0. */
  const stageBottom = () => {
    const first = steps[0];
    if (!pin || !first) return 0;
    const across = pin.getBoundingClientRect().left < first.getBoundingClientRect().right;
    return across ? pin.offsetHeight : 0;
  };

  let observer: IntersectionObserver | undefined;
  /** Watches the steps against the reading line, which moves when the stage changes size. */
  const watch = () => {
    observer?.disconnect();
    const viewport = window.innerHeight;
    const line = readingLine(viewport, stageBottom());
    observer = new IntersectionObserver(
      (entries) => {
        if (holding) return;
        for (const entry of entries) {
          if (entry.isIntersecting) show(steps.findIndex((step) => step === entry.target));
        }
      },
      { rootMargin: `-${Math.round(line)}px 0px -${Math.round(viewport - line - 1)}px 0px` },
    );
    for (const step of steps) observer.observe(step);
  };

  /** How far the stage reaches to the viewport's edge, measured without the scrollbar. */
  const measure = () => {
    root.style.setProperty("--viewport", `${document.documentElement.clientWidth}px`);
    watch();
  };
  measure();
  window.addEventListener("resize", measure);

  // A jump makes its step current at once and holds it there while the page travels, so the
  // drawing doesn't act out every step the scroll passes on the way.
  let release = 0;
  jumps.forEach((jump, index) => {
    jump.addEventListener("click", (event) => {
      const step = steps[index];
      if (!step) return;
      event.preventDefault();
      show(index);
      holding = true;
      window.clearTimeout(release);
      const done = () => {
        holding = false;
      };
      window.addEventListener("scrollend", done, { once: true });
      release = window.setTimeout(done, 1600);
      const box = step.getBoundingClientRect();
      const line = readingLine(window.innerHeight, stageBottom());
      window.scrollTo({
        top: window.scrollY + box.top + box.height / 2 - line,
        behavior: still ? "auto" : "smooth",
      });
      history.replaceState(null, "", `#${step.id}`);
    });
  });
}
