import { cueFace } from "./spade-cast.ts";
import { stepEvent } from "./scroll-story.ts";
import { finishedAt, poseAt, showsAt } from "./spade-story.ts";

/*
 * Acts out the /spade/ story's scene (components/spade/Scene.astro) at the current step: each
 * piece marked `data-in` shows only in its steps, each face marked `data-poses` takes its pose
 * (hopping on the step it finishes), and pieces that have just appeared are marked `data-new`
 * for one short fade. The scene starts at the first step; the story's script moves it on.
 */

export function startScene(root: HTMLElement): void {
  const pieces = [...root.querySelectorAll<HTMLElement | SVGElement>(".scene [data-in]")];
  const faces = [...root.querySelectorAll<SVGElement>(".scene [data-poses]")];
  const scene = root.querySelector<HTMLElement>(".scene");

  const act = (step: number) => {
    if (scene) scene.dataset.step = String(step);
    for (const piece of pieces) {
      const shown = showsAt(piece.dataset.in ?? "", step);
      const was = !piece.hasAttribute("hidden");
      if (shown) piece.removeAttribute("hidden");
      else piece.setAttribute("hidden", "");
      if (shown && !was) {
        piece.dataset.new = "";
        setTimeout(() => piece.removeAttribute("data-new"), 900);
      }
    }
    for (const face of faces) {
      const plan = face.dataset.poses ?? "";
      face.dataset.state = poseAt(plan, step);
      if (finishedAt(plan, step)) cueFace(face, "hop");
    }
  };

  act(0);
  root.addEventListener(stepEvent, (event) => {
    if (event instanceof CustomEvent && typeof event.detail === "number") act(event.detail);
  });
}
