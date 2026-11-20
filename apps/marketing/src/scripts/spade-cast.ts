import { blinkDelay, gazeToward, readGaze, type Gaze } from "./spade-gaze.ts";

/*
 * Brings the /spade/ page's cast to life: every face marked `data-live` glances toward the
 * pointer while it is on screen, rests on its own look when the pointer leaves, and blinks every
 * few seconds. A face can be told to hop (`cueFace`). Nothing runs without html.motion, so with
 * reduced motion or no script the faces hold their drawn poses.
 */

const motion = () => document.documentElement.classList.contains("motion");

/** Plays a one-off cue on a face ("blink" or "hop"), restarting it if it is already playing. */
export function cueFace(face: SVGElement, kind: "blink" | "hop"): void {
  if (!motion()) return;
  face.removeAttribute("data-cue");
  // Reading the box restarts the animation when the same cue comes twice in a row.
  void face.getBoundingClientRect();
  face.dataset.cue = kind;
  setTimeout(() => {
    if (face.dataset.cue === kind) face.removeAttribute("data-cue");
  }, 800);
}

/** Points a face's pupils at a look, or back to its resting one. */
export function lookAt(face: SVGElement, gaze: Gaze | undefined): void {
  const shown = gaze ?? readGaze(face.dataset.rest);
  if (!shown) {
    face.removeAttribute("data-look");
    return;
  }
  face.style.setProperty("--lx", String(shown.x));
  face.style.setProperty("--ly", String(shown.y));
  face.dataset.look = "";
}

const seen = new Set<SVGElement>();
const watching = new WeakSet<SVGElement>();
let pointer: { x: number; y: number } | undefined;
let frame = 0;

const follow = () => {
  frame = 0;
  for (const face of seen) {
    lookAt(face, pointer ? gazeToward(face.getBoundingClientRect(), pointer) : undefined);
  }
};

const observer =
  typeof IntersectionObserver === "undefined"
    ? undefined
    : new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const face = entry.target as SVGElement;
          if (entry.isIntersecting) seen.add(face);
          else seen.delete(face);
        }
      });

function blinkLater(face: SVGElement): void {
  setTimeout(() => {
    if (seen.has(face) && face.dataset.state !== "working" && face.dataset.state !== "done") {
      cueFace(face, "blink");
    }
    blinkLater(face);
  }, blinkDelay(Math.random()));
}

/** Watches the live faces under `root`; call again after drawing new ones. */
export function startCast(root: ParentNode = document): void {
  if (!motion() || !observer) return;
  for (const face of root.querySelectorAll<SVGElement>("svg.bot-face[data-live]")) {
    if (watching.has(face)) continue;
    watching.add(face);
    observer.observe(face);
    blinkLater(face);
  }
}

if (typeof document !== "undefined") {
  addEventListener(
    "pointermove",
    (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      if (!frame && motion()) frame = requestAnimationFrame(follow);
    },
    { passive: true },
  );
  document.documentElement.addEventListener("pointerleave", () => {
    pointer = undefined;
    if (!frame && motion()) frame = requestAnimationFrame(follow);
  });
}
