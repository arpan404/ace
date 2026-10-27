/*
 * Reveals sections as they scroll into view, once each (styles/motion.css does the moving).
 * Base.astro adds <html class="motion"> before paint when reduced motion is off; this marks the
 * page ready, numbers siblings and rows for staggering, and adds .is-in on first sight.
 */

/** Siblings that reveal together stagger by their order, up to a short cap. */
function numberSiblings(elements: Iterable<HTMLElement>): void {
  for (const element of elements) {
    const parent = element.parentElement;
    if (!parent) continue;
    const peers = [...parent.children].filter((child) => child.classList.contains("reveal"));
    element.style.setProperty("--i", String(Math.min(peers.indexOf(element), 5)));
  }
}

/** Gives each row its place, capped so long lists don't keep the last item waiting. */
function number(rows: Iterable<HTMLElement>): void {
  let index = 0;
  for (const row of rows) row.style.setProperty("--row", String(Math.min(index++, 8)));
}

/** Rows inside each product panel, and items of each data-stagger list, arrive in order. */
function numberRows(root: ParentNode): void {
  for (const group of root.querySelectorAll<HTMLElement>(".panel, .board, .fleet")) {
    number(
      group.querySelectorAll<HTMLElement>(":scope > .panel-row, :scope li, :scope > .machine"),
    );
  }
  for (const list of root.querySelectorAll<HTMLElement>("[data-stagger]")) {
    number(list.querySelectorAll<HTMLElement>(":scope > *"));
  }
}

export function startMotion(): void {
  const root = document.documentElement;
  if (!root.classList.contains("motion")) return;
  root.dataset.motionReady = "";

  const targets = [...document.querySelectorAll<HTMLElement>(".reveal")];
  numberSiblings(targets);
  numberRows(document);

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
  );
  for (const target of targets) observer.observe(target);
}
