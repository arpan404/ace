import type { StepPart } from "../content/features.ts";
import { arrange, chooseLayout, shotCamera, travelled, type CastId } from "./feature-camera.ts";
import { playMove } from "./feature-moves.ts";
import { readFocus, startsMove, type PlayedMove, type StepPlan } from "./feature-steps.ts";
import { stepEvent } from "./scroll-story.ts";
import { createAct, placePointer, tickClocks } from "./stage-act.ts";
import { show } from "./stage-scenes.ts";
import { between, link, project, union, type Camera, type Rect, type Size } from "./zoom-camera.ts";

/*
 * Plays a feature page's picture (components/features/FeatureStory.astro): ace on a MacBook,
 * with the other hardware the feature involves standing beside it. As each step of the page's
 * scroll story becomes current, the drawing plays that step's move (feature-moves.ts) and the
 * camera travels to what the step is about: whole devices, or one part of ace's window, read
 * from where it is on screen. feature-camera.ts and feature-steps.ts decide; this applies.
 * With reduced motion the camera cuts and every scene jumps to its end.
 */

const q = (root: ParentNode, selector: string) => root.querySelector<HTMLElement>(selector);

/** Where each part of ace's window is found, and how to read its box. */
const partBoxes: Record<StepPart, { selector: string; layout?: boolean; height?: number }> = {
  window: { selector: "[data-window]" },
  threads: { selector: ".ace .threads" },
  thread: { selector: ".ace .column", height: 440 },
  canvas: { selector: ".ace .canvas" },
  dock: { selector: ".ace .dock" },
  // Panels and the Simulator slide in, so they are read where they come to rest.
  changes: { selector: ".ace .side-changes", layout: true },
  diff: { selector: ".ace .side-changes .file" },
  commit: { selector: ".ace .side-changes", layout: true, height: 250 },
  browser: { selector: ".ace .side-browser", layout: true },
  sim: { selector: "[data-sim]", layout: true },
};

const castIds: readonly string[] = ["mac", "build", "workstation", "phone"] satisfies CastId[];
const isCast = (id: string | undefined): id is CastId => id !== undefined && castIds.includes(id);

/** Two cameras close enough that moving between them would only jiggle the picture. */
function same(a: Camera, b: Camera): boolean {
  return (
    Math.abs(a.scale / b.scale - 1) < 0.02 && Math.abs(a.x - b.x) < 6 && Math.abs(a.y - b.y) < 6
  );
}

export function startFeatureStory(frame: HTMLElement, plan: StepPlan[]): void {
  const story = frame.closest<HTMLElement>("[data-scroll-story]");
  const world = q(frame, "[data-world]");
  const mac = q(frame, '[data-thing="mac"]');
  const desk = mac && q(mac, "[data-desktop]");
  const pointer = mac && q(mac, "[data-pointer]");
  if (!story || !world || !mac || !desk || !pointer || plan.length === 0) return;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const things = [...frame.querySelectorAll<HTMLElement>("[data-thing]")];
  const cast = things.map((thing) => thing.dataset.thing).filter(isCast);
  const thing = (id: CastId) => things.find((entry) => entry.dataset.thing === id);
  const phone = q(frame, '[data-thing="phone"]');
  const labels = [...frame.querySelectorAll<HTMLElement>("[data-label]")];
  const paths = [...frame.querySelectorAll<SVGPathElement>("[data-link]")];
  const verbs = [...frame.querySelectorAll<HTMLElement>("[data-verb]")];

  // ace is open on every machine: the Mac on the page's thread, the build server testing
  // sign-in on a borrowed iPhone, the workstation checking a page in ace's browser.
  show(mac, { thread: "cold-start", approved: true });
  const server = thing("build");
  if (server) show(server, { thread: "sign-in" });
  const workstation = thing("workstation");
  if (workstation) {
    show(workstation, { thread: "staging", approved: true });
    q(workstation, ".ace")?.setAttribute("data-panel", "browser");
    for (const step of workstation.querySelectorAll(".browser-step"))
      step.classList.remove("pending");
  }
  tickClocks(frame);
  placePointer(pointer, 900, 600);
  frame.dataset.live = "";

  let size: Size = { width: 1, height: 1 };
  let camera: Camera = { scale: 0.3, x: 0, y: 0 };
  let places: Partial<Record<CastId, Rect>> = {};
  let lids: Partial<Record<CastId, Rect>> = {};
  let mids: { x: number; y: number }[] = [];

  /** An element's box in the world's pixels, read from where it is on screen now. */
  const rectOf = (element: HTMLElement): Rect => {
    const origin = world.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return {
      x: (box.left - origin.left) / camera.scale,
      y: (box.top - origin.top) / camera.scale,
      width: box.width / camera.scale,
      height: box.height / camera.scale,
    };
  };

  /** Where an element comes to rest inside its positioned parent, whatever it is sliding from. */
  const restingRect = (element: HTMLElement): Rect => {
    const parent = element.offsetParent;
    const base = parent instanceof HTMLElement ? rectOf(parent) : { x: 0, y: 0 };
    return {
      x: base.x + element.offsetLeft,
      y: base.y + element.offsetTop,
      width: element.offsetWidth,
      height: element.offsetHeight,
    };
  };

  /** Stands the hardware for this frame's shape, and draws the lines between it. */
  function place(): void {
    size = { width: frame.clientWidth, height: frame.clientHeight };
    places = arrange(cast, chooseLayout(cast, size));
    for (const entry of things) {
      const at = isCast(entry.dataset.thing) ? places[entry.dataset.thing] : undefined;
      if (!at) continue;
      entry.style.left = `${at.x}px`;
      entry.style.top = `${at.y}px`;
    }
    world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
    lids = Object.fromEntries(
      things.map((entry) => [entry.dataset.thing ?? "", rectOf(q(entry, "[data-lid]") ?? entry)]),
    );
    const from = lids.mac;
    mids = paths.map((path) => {
      const to = isCast(path.dataset.to) ? lids[path.dataset.to] : undefined;
      if (!from || !to) return { x: 0, y: 0 };
      path.setAttribute("d", link(from, to));
      const half = path.getPointAtLength(path.getTotalLength() / 2);
      return { x: half.x, y: half.y };
    });
  }

  /** The camera for a step, measured from the drawing as it is now. */
  function aimFor(index: number): Camera | undefined {
    const step = plan[Math.min(index, plan.length - 1)];
    if (!step) return undefined;
    const focus = readFocus(step.focus);
    if (focus.kind === "device") {
      const rects = focus.cast.flatMap((id) => places[id] ?? []);
      return rects.length > 0 ? shotCamera(union(rects), "device", size) : undefined;
    }
    const spec = partBoxes[focus.part];
    const element = q(mac, spec.selector);
    if (!element) return undefined;
    const rect = spec.layout ? restingRect(element) : rectOf(element);
    const height = spec.height ? Math.min(spec.height, rect.height) : rect.height;
    return shotCamera({ ...rect, height }, "part", size);
  }

  function render(): void {
    world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
    for (const label of labels) {
      const lid = isCast(label.dataset.label) ? lids[label.dataset.label] : undefined;
      if (!lid) continue;
      const at = project(camera, lid);
      label.style.transform = `translate(${at.x}px, ${at.y}px)`;
    }
    verbs.forEach((verb, index) => {
      const mid = mids[index];
      if (!mid) return;
      const at = project(camera, mid);
      verb.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -50%)`;
    });
  }

  let from = camera;
  let target = camera;
  let started = 0;
  let pending = 0;

  function tick(now: number): void {
    const t = still ? 1 : travelled(now - started);
    camera = between(from, target, t, size);
    render();
    pending = t < 1 ? requestAnimationFrame(tick) : 0;
  }

  /** Sends the camera toward `next`, from wherever it is now; `cut` jumps straight there. */
  function travel(next: Camera | undefined, cut = false): void {
    if (!next || same(next, target)) return;
    from = camera;
    target = next;
    started = performance.now();
    if (cut) {
      camera = next;
      from = next;
      render();
      return;
    }
    if (!pending) pending = requestAnimationFrame(tick);
  }

  let current = -1;
  let playing: PlayedMove | undefined;
  let run = 0;
  const stage = { root: mac, desk, pointer, scale: () => camera.scale, still };

  /** A step becomes current: its move plays, and the camera follows what it's about. */
  function enter(index: number): void {
    current = index;
    travel(aimFor(index));
    const move = startsMove(plan, index, playing);
    if (!move) return;
    playing = move;
    const token = ++run;
    const act = createAct(stage, () => token === run);
    // Parts that slide in or grow as the move plays are framed again once they have settled.
    window.setTimeout(() => token === run && travel(aimFor(current)), 1400);
    void playMove(move, { mac, phone }, act).then(() => {
      if (token === run) travel(aimFor(current));
    });
  }

  place();
  // The picture opens on every piece of hardware, then the first step takes the camera in.
  const opening = cast.flatMap((id) => places[id] ?? []);
  travel(shotCamera(union(opening), "device", size), true);

  new ResizeObserver(() => {
    place();
    travel(
      current < 0
        ? shotCamera(union(cast.flatMap((id) => places[id] ?? [])), "device", size)
        : aimFor(current),
      true,
    );
  }).observe(frame);

  const looking = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting) || current >= 0) return;
      enter(Number(story.dataset.step ?? 0));
    },
    { threshold: 0.4 },
  );
  looking.observe(frame);
  story.addEventListener(stepEvent, (event) => {
    if (event instanceof CustomEvent && typeof event.detail === "number" && current >= 0) {
      enter(event.detail);
    }
  });
}
