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
import {
  Box3,
  DirectionalLight,
  Group,
  HemisphereLight,
  type Mesh,
  type MeshStandardMaterial,
  NeutralToneMapping,
  type Object3D,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/*
 * Spade in 3D (public/spade.glb, built by blender/spade.py) on a canvas. Its pupils follow the
 * pointer with the mark's own look maths (`@ace/ui-core/spade`): the look the pointer asks for,
 * clamped inside the eye, becomes a turn of the pupil about the head's centre, which slides it
 * across the eye's surface. The head turns a little toward the pointer, floats, and blinks on
 * the mark's schedule. With reduced motion it is drawn once, at rest. Unlike the flat mark, the
 * head stays white in both themes.
 */

/** The model's units per unit of the mark's 24-unit grid, and the head's radius in them. */
const unit = 0.1;
const radius = 10.6 * unit;
/** How far the head turns toward the pointer, in radians. */
const headTurn = { yaw: 0.32, pitch: 0.2 };
const blinkEvery = 5200;

const clamp = (value: number) => Math.max(-1, Math.min(1, value));

interface Eye {
  /** Squashes the eye toward its centre for a blink. */
  lid: Object3D;
  /** Turns the pupil and its catchlight about the head's centre. */
  look: Object3D;
  /** The blink's delay after the first eye, in ms. */
  late: number;
}

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

/** Moves a part's meshes under `parent`, keeping where they are in the model. */
function adopt(parent: Object3D, parts: Object3D[], at: Vector3): void {
  for (const part of parts) {
    parent.add(part);
    part.position.sub(at);
  }
}

/** Splits one side's face into a blinking lid and a turning pupil. */
function rigEye(model: Object3D, side: "L" | "R", late: number): Eye | undefined {
  const named = (name: string) => model.getObjectByName(`${name}_${side}`);
  const ring = named("Ring");
  const eye = named("Eye");
  const pupil = named("Pupil");
  const glint = named("Glint");
  if (!ring || !eye || !pupil || !glint) return undefined;
  const centre = new Box3().setFromObject(eye).getCenter(new Vector3());
  const lid = new Group();
  lid.position.copy(centre);
  model.add(lid);
  adopt(lid, [ring, eye], centre);
  // The pupil turns about the head's centre, which sits at -centre inside the lid.
  const look = new Group();
  look.position.copy(centre).negate();
  lid.add(look);
  look.add(pupil, glint);
  return { lid, look, late };
}

/** The head is white on both pages, matte so the key light reads as soft shading. */
const headFinish = { colour: "#ffffff", roughness: 0.62 };

export async function startSpade3d(host: HTMLElement, src: string): Promise<boolean> {
  const canvas = host.querySelector<HTMLCanvasElement>("canvas");
  if (!canvas) return false;
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    return false;
  }
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NeutralToneMapping;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  // Lit like the Blender still: a soft key from the upper left, a dim fill from the right and
  // a rim from behind that lifts the edge off the page. The room only adds faint reflections.
  const scene = new Scene();
  const environment = new PMREMGenerator(renderer);
  scene.environment = environment.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.18;
  environment.dispose();
  scene.add(new HemisphereLight(0xffffff, 0x101010, 0.3));
  for (const [x, y, z, strength] of [
    [-3, 4, 4, 2.6],
    [4, 0.5, 3, 0.3],
    [1, 3, -4, 1.4],
  ] as const) {
    const light = new DirectionalLight(0xffffff, strength);
    light.position.set(x, y, z);
    scene.add(light);
  }

  const camera = new PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 0, 5.2);

  let model: Object3D;
  try {
    model = (await new GLTFLoader().loadAsync(src)).scene;
  } catch {
    renderer.dispose();
    return false;
  }
  const root = new Group();
  root.add(model);
  scene.add(root);
  const head = model.getObjectByName("Head") as Mesh | undefined;
  const headMaterial = head?.material as MeshStandardMaterial | undefined;
  headMaterial?.color.set(headFinish.colour);
  if (headMaterial) headMaterial.roughness = headFinish.roughness;
  const eyes = [rigEye(model, "L", 0), rigEye(model, "R", 30)].filter(
    (eye): eye is Eye => eye !== undefined,
  );

  const fit = () => {
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  fit();

  let look: SpadeLook = { ...spadeRestLook };
  let target: SpadeLook = { ...spadeRestLook };
  /** Where the pointer is from the canvas's centre, as a share of the viewport, eased. */
  const toward = { x: 0, y: 0 };
  const towardTarget = { x: 0, y: 0 };

  const pose = (time: number) => {
    look = approachSpadeLook(look, target);
    if (spadeLookSettled(look, target)) look = { ...target };
    const shift = pupilShift(look);
    for (const eye of eyes) {
      eye.look.rotation.set((shift.y * unit) / radius, (shift.x * unit) / radius, 0);
      const t = ((time - eye.late) % blinkEvery) / blinkEvery;
      const closing = t > 0.94 && t < 0.97 ? 1 - Math.abs(t - 0.955) / 0.015 : 0;
      eye.lid.scale.y = 1 - 0.92 * Math.max(0, closing);
    }
    toward.x += (towardTarget.x - toward.x) * 0.08;
    toward.y += (towardTarget.y - toward.y) * 0.08;
    root.rotation.set(toward.y * headTurn.pitch, toward.x * headTurn.yaw, 0);
    root.position.y = Math.sin(time / 1400) * 0.035;
    renderer.render(scene, camera);
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
