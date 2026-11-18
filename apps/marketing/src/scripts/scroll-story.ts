/*
 * Drives an inner page's story (components/site/ScrollStory.astro): the step crossing the
 * middle of the screen becomes the current one. The root's `data-step` and the
 * `scrollstory:step` event tell the drawing which step that is.
 */

/** The event a story fires when its current step changes; `detail` is the step's index. */
export const stepEvent = "scrollstory:step";

export function startScrollStory(root: HTMLElement): void {
  const steps = [...root.querySelectorAll<HTMLElement>("[data-scroll-step]")];
  if (steps.length === 0) return;
  root.dataset.live = "";

  let current = 0;
  const show = (index: number) => {
    if (index < 0 || index === current) return;
    current = index;
    root.dataset.step = String(index);
    steps.forEach((step, at) => step.classList.toggle("on", at === index));
    root.dispatchEvent(new CustomEvent<number>(stepEvent, { detail: index }));
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) show(steps.findIndex((step) => step === entry.target));
      }
    },
    { rootMargin: "-50% 0px -50% 0px" },
  );
  for (const step of steps) observer.observe(step);
}
