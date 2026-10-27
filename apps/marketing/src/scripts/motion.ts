import { playStories, prepareStories } from "./stories.ts";

/*
 * Drives the site's motion (styles/motion.css): headings rise word by word, sections fade in
 * once, product panels play their stories (stories.ts) when they come into view, and tiles marked
 * .spot carry a light under the pointer. Base.astro adds <html class="motion"> before paint when
 * reduced motion is off; this marks the page ready so that class is kept.
 */

/** Siblings that reveal together fade in a beat apart, up to a short cap. */
function numberSiblings(elements: Iterable<HTMLElement>): void {
  for (const element of elements) {
    const parent = element.parentElement;
    if (!parent) continue;
    const peers = [...parent.children].filter((child) => child.classList.contains("reveal"));
    element.style.setProperty("--i", String(Math.min(peers.indexOf(element), 5)));
  }
}

/** Gives each item its place, capped so long lists don't keep the last one waiting. */
function number(items: Iterable<HTMLElement>): void {
  let index = 0;
  for (const item of items) item.style.setProperty("--row", String(Math.min(index++, 8)));
}

/** Wraps each word of a heading so it can rise from behind its own mask. */
function splitWords(heading: HTMLElement): void {
  const words = (heading.textContent ?? "").trim().split(/\s+/);
  heading.setAttribute("aria-label", words.join(" "));
  heading.replaceChildren(
    ...words.flatMap((word, index) => {
      const outer = document.createElement("span");
      outer.className = "w";
      outer.setAttribute("aria-hidden", "true");
      const inner = document.createElement("span");
      inner.textContent = word;
      inner.style.setProperty("--w", String(index));
      outer.append(inner);
      return index < words.length - 1 ? [outer, document.createTextNode(" ")] : [outer];
    }),
  );
}

/** Tracks the pointer inside .spot tiles for their light. */
function followPointer(): void {
  document.addEventListener(
    "pointermove",
    (event) => {
      const target =
        event.target instanceof Element ? event.target.closest<HTMLElement>(".spot") : null;
      if (!target) return;
      const box = target.getBoundingClientRect();
      target.style.setProperty("--mx", `${event.clientX - box.left}px`);
      target.style.setProperty("--my", `${event.clientY - box.top}px`);
    },
    { passive: true },
  );
}

export function startMotion(): void {
  const root = document.documentElement;
  followPointer();
  if (!root.classList.contains("motion")) return;
  root.dataset.motionReady = "";

  for (const heading of document.querySelectorAll<HTMLElement>(".section-title")) {
    splitWords(heading);
  }
  const targets = [...document.querySelectorAll<HTMLElement>(".reveal")];
  numberSiblings(targets);
  for (const list of document.querySelectorAll<HTMLElement>("[data-stagger]")) {
    number(list.querySelectorAll<HTMLElement>(":scope > *"));
  }
  prepareStories(document);

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        playStories(entry.target);
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -12% 0px", threshold: 0.15 },
  );
  for (const target of targets) observer.observe(target);
}
