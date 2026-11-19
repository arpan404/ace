/** One viewport observer for every face, with no React renders on scroll. */
let observer: IntersectionObserver | undefined;
const faces = new Set<Element>();

export function observeBotFace(face: SVGSVGElement) {
  if (typeof IntersectionObserver === "undefined") return;
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const visible = entry.isIntersecting;
      entry.target.setAttribute("data-visible", String(visible));
      if (entry.target instanceof SVGElement)
        entry.target.style.setProperty("--bf-play-state", visible ? "running" : "paused");
    }
  });
  face.setAttribute("data-visible", "false");
  face.style.setProperty("--bf-play-state", "paused");
  faces.add(face);
  observer.observe(face);
  return () => {
    observer?.unobserve(face);
    faces.delete(face);
    if (faces.size === 0) {
      observer?.disconnect();
      observer = undefined;
    }
  };
}
