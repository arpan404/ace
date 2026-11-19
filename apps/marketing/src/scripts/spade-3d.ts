import {
  approachSpadeLook,
  clampSpadeLook,
  spadeLookFromPointer,
  spadeLookSettled,
  spadePupilForSize,
  spadeRestLook,
  spadeTiltDeg,
  type SpadeLook,
} from "@ace/ui-core/spade";
import { readSpadeGlb } from "./spade-glb.ts";
import {
  type Drawable,
  type Mat4,
  identity,
  multiply,
  perspective,
  rotationX,
  rotationY,
  scaling,
  spadeProgram,
  translation,
  upload,
} from "./spade-gl.ts";

/*
 * Spade in 3D (public/spade.glb, built by blender/spade.py) on a canvas, drawn with plain WebGL
 * (spade-gl.ts) so the page carries no 3D library. Its pupils follow the pointer with the mark's
 * own look maths (`@ace/ui-core/spade`): the look the pointer asks for, clamped inside the eye,
 * becomes a turn of the pupil about the head's centre, which slides it across the eye's surface.
 * The head turns a little toward the pointer, floats, and blinks on the mark's schedule. It is
 * white in both themes. With reduced motion it is drawn once, at rest.
 */

/** The model's units per unit of the mark's 24-unit grid, and the head's radius in them. */
const unit = 0.1;
const radius = 10.6 * unit;
/** How far the head turns toward the pointer, in radians. */
const headTurn = { yaw: 0.32, pitch: 0.2 };
const blinkEvery = 5200;
const camera = { distance: 5.2, fovY: (30 * Math.PI) / 180 };
const head = { colour: [1, 1, 1], roughness: 0.62 } as const;

const clamp = (value: number) => Math.max(-1, Math.min(1, value));

/** The pupil's shift for a look, in the grid's units with y down, past the resting place. */
function pupilShift(look: SpadeLook): { x: number; y: number } {
  const { pupil, pad } = spadePupilForSize(132);
  const shown = clampSpadeLook(look, pupil, pad);
  const rest = clampSpadeLook(spadeRestLook, pupil, pad);
  // The face is turned by the mark's tilt, so its shift is too.
  const tilt = (spadeTiltDeg * Math.PI) / 180;
  const dx = shown.dx - rest.dx;
  const dy = shown.dy - rest.dy;
  return {
    x: dx * Math.cos(tilt) - dy * Math.sin(tilt),
    y: dx * Math.sin(tilt) + dy * Math.cos(tilt),
  };
}

/** Squashes an eye toward its centre for a blink, `open` from 1 to nearly 0. */
function lid(centre: readonly number[], open: number): Mat4 {
  const [x = 0, y = 0, z = 0] = centre;
  return multiply(translation(x, y, z), multiply(scaling(1, open, 1), translation(-x, -y, -z)));
}

/** How open an eye is at `time`, blinking once every `blinkEvery` ms. */
function openness(time: number, late: number): number {
  const t = ((((time - late) % blinkEvery) + blinkEvery) % blinkEvery) / blinkEvery;
  const closing = t > 0.94 && t < 0.97 ? 1 - Math.abs(t - 0.955) / 0.015 : 0;
  return 1 - 0.92 * Math.max(0, closing);
}

export async function startSpade3d(host: HTMLElement, src: string): Promise<boolean> {
  const canvas = host.querySelector<HTMLCanvasElement>("canvas");
  const gl = canvas?.getContext("webgl2", { antialias: true, premultipliedAlpha: true });
  if (!canvas || !gl) return false;

  let parts: Drawable[];
  let program: ReturnType<typeof spadeProgram>;
  try {
    const response = await fetch(src);
    if (!response.ok) return false;
    parts = readSpadeGlb(await response.arrayBuffer()).map((mesh) => upload(gl, mesh));
    program = spadeProgram(gl);
  } catch {
    return false;
  }
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 0);

  const part = (name: string) => parts.find((item) => item.mesh.name === name);
  const headPart = part("Head");
  const sides = (["L", "R"] as const).map((side, index) => ({
    lid: [part(`Ring_${side}`), part(`Eye_${side}`)],
    look: [part(`Pupil_${side}`), part(`Glint_${side}`)],
    centre: part(`Eye_${side}`)?.mesh.centre ?? [0, 0, 0],
    late: index * 30,
  }));

  let projection = identity();
  const fit = () => {
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;
    const ratio = Math.min(devicePixelRatio, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    gl.viewport(0, 0, canvas.width, canvas.height);
    projection = perspective(camera.fovY, width / height, 3, 8);
  };
  fit();
  const view = translation(0, 0, -camera.distance);

  let look: SpadeLook = { ...spadeRestLook };
  let target: SpadeLook = { ...spadeRestLook };
  /** Where the pointer is from the canvas's centre, as a share of the viewport, eased. */
  const toward = { x: 0, y: 0 };
  const towardTarget = { x: 0, y: 0 };

  const draw = (items: (Drawable | undefined)[], model: Mat4) => {
    for (const item of items) {
      if (item) program.draw(item, model, item.mesh.colour, item.mesh.roughness);
    }
  };

  const pose = (time: number) => {
    look = approachSpadeLook(look, target);
    if (spadeLookSettled(look, target)) look = { ...target };
    toward.x += (towardTarget.x - toward.x) * 0.08;
    toward.y += (towardTarget.y - toward.y) * 0.08;
    const lift = Math.sin(time / 1400) * 0.035;
    const root = multiply(
      translation(0, lift, 0),
      multiply(rotationX(toward.y * headTurn.pitch), rotationY(toward.x * headTurn.yaw)),
    );
    const shift = pupilShift(look);
    const turn = multiply(
      rotationX((shift.y * unit) / radius),
      rotationY((shift.x * unit) / radius),
    );

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    program.frame(multiply(projection, view), [0, 0, camera.distance], [0, lift, 0]);
    if (headPart) program.draw(headPart, root, head.colour, head.roughness);
    for (const side of sides) {
      const eye = multiply(root, lid(side.centre, openness(time, side.late)));
      draw(side.lid, eye);
      draw(side.look, multiply(eye, turn));
    }
  };

  new ResizeObserver(() => {
    fit();
    pose(performance.now());
  }).observe(canvas);

  pose(0);
  host.dataset.ready = "";
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return true;

  addEventListener(
    "pointermove",
    (event) => {
      const rect = canvas.getBoundingClientRect();
      target = spadeLookFromPointer(rect, { x: event.clientX, y: event.clientY });
      towardTarget.x = clamp((event.clientX - (rect.left + rect.width / 2)) / (innerWidth / 2));
      towardTarget.y = clamp((event.clientY - (rect.top + rect.height / 2)) / (innerHeight / 2));
    },
    { passive: true },
  );
  document.documentElement.addEventListener("pointerleave", () => {
    target = { ...spadeRestLook };
    towardTarget.x = 0;
    towardTarget.y = 0;
  });

  // It moves only while on screen.
  let visible = false;
  let frame = 0;
  const tick = (time: number) => {
    pose(time);
    frame = visible ? requestAnimationFrame(tick) : 0;
  };
  new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    if (visible && !frame) frame = requestAnimationFrame(tick);
  }).observe(canvas);
  return true;
}
