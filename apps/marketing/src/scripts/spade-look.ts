import {
  approachSpadeLook,
  clampSpadeLook,
  spadeLookFromPointer,
  spadeLookSettled,
  spadeRestLook,
  type SpadeLook,
} from "@ace/ui-core/spade";

/*
 * Spade's pupils turn toward the pointer, easing there a frame at a time, and rest again when
 * the pointer leaves. The maths is the app's (`@ace/ui-core/spade`); this only reads the
 * pointer and moves the drawn pupils. Off under reduced motion.
 */
export function spadeLook(section: HTMLElement): void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const face = section.querySelector<SVGSVGElement>("[data-spade]");
  if (!face) return;
  const pupils = [...face.querySelectorAll<SVGGElement>("[data-spade-pupil]")];
  const pupil = { rx: Number(face.dataset.pupilRx), ry: Number(face.dataset.pupilRy) };
  const pad = Number(face.dataset.pad);
  let look: SpadeLook = { ...spadeRestLook };
  let target: SpadeLook = { ...spadeRestLook };
  let frame = 0;

  const draw = () => {
    look = approachSpadeLook(look, target);
    if (spadeLookSettled(look, target)) look = { ...target };
    const shown = clampSpadeLook(look, pupil, pad);
    const rest = clampSpadeLook(spadeRestLook, pupil, pad);
    for (const element of pupils) {
      element.setAttribute("transform", `translate(${shown.dx - rest.dx} ${shown.dy - rest.dy})`);
    }
    frame = spadeLookSettled(look, target) ? 0 : requestAnimationFrame(draw);
  };
  const aim = (next: SpadeLook) => {
    target = next;
    if (!frame) frame = requestAnimationFrame(draw);
  };

  addEventListener(
    "pointermove",
    (event) =>
      aim(
        spadeLookFromPointer(face.getBoundingClientRect(), { x: event.clientX, y: event.clientY }),
      ),
    { passive: true },
  );
  document.documentElement.addEventListener("pointerleave", () => aim({ ...spadeRestLook }));
}
