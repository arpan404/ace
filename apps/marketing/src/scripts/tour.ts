import { playStories } from "./stories.ts";

/*
 * The home tour (components/Tour.astro): the step nearest the middle of the screen becomes
 * current, its scene shows on the pinned stage, the rail fills to it, and with motion on, its
 * scene plays its story once. Works without motion too; only the stories stay still.
 */

/** Whether an element is laid out (not inside something display: none). */
const shown = (element: HTMLElement | null | undefined): element is HTMLElement =>
  Boolean(element && element.offsetParent !== null);

function activate(tour: HTMLElement, index: number): void {
  const steps = [...tour.querySelectorAll<HTMLElement>("[data-tour-step]")];
  const scenes = [...tour.querySelectorAll<HTMLElement>("[data-tour-scene]")];
  steps.forEach((step, at) => {
    if (at === index) step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
  });
  scenes.forEach((scene, at) => scene.classList.toggle("on", at === index));
  tour
    .querySelector<HTMLElement>(".steps")
    ?.style.setProperty("--progress", String((index + 1) / steps.length));

  if (!document.documentElement.classList.contains("motion")) return;
  const pinned = scenes[index];
  if (shown(pinned)) playStories(pinned);
  const inline = steps[index]?.querySelector<HTMLElement>(".inline-scene");
  if (shown(inline)) playStories(inline);
}

export function startTour(): void {
  for (const tour of document.querySelectorAll<HTMLElement>("[data-tour]")) {
    const steps = [...tour.querySelectorAll<HTMLElement>("[data-tour-step]")];
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting)
            activate(
              tour,
              steps.findIndex((step) => step === entry.target),
            );
        }
      },
      // A step counts once it crosses the middle tenth of the screen.
      { rootMargin: "-45% 0px -45% 0px" },
    );
    for (const step of steps) observer.observe(step);
  }
}
