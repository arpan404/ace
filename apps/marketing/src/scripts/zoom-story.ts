import { scroll } from "motion";
import { show, tone } from "./stage-scenes.ts";
import {
  between,
  captionAt,
  frame,
  legAt,
  link,
  project,
  shotOrder,
  storyAt,
  union,
  type Camera,
  type Rect,
  type Shot,
  type Size,
  type StoryState,
} from "./zoom-camera.ts";

/*
 * Plays the home page's zoom-out (components/zoom/ZoomStory.astro). It measures the drawing,
 * frames each shot for the visitor's screen, follows the scroll with a camera that eases
 * toward it, and flips the drawing's `data-*` state as the story reaches each point
 * (zoom-camera.ts decides where and when). Labels sit outside the scaled drawing and are
 * moved to their place every frame, so they stay the same size at every zoom. With reduced
 * motion the camera cuts from shot to shot instead of travelling.
 */

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** A box with `by` pixels of room added on every side. */
function grow(rect: Rect, by: number): Rect {
  return {
    x: rect.x - by,
    y: rect.y - by,
    width: rect.width + by * 2,
    height: rect.height + by * 2,
  };
}

export function startZoomStory(root: HTMLElement): void {
  const q = (selector: string) => root.querySelector<HTMLElement>(selector);
  const stage = q("[data-zoom-stage]");
  const world = q("[data-zoom-world]");
  const grid = q("[data-zoom-grid]");
  const hero = q("[data-zoom-hero]");
  const edge = q("[data-zoom-edge]");
  const captions = q("[data-zoom-captions]");
  const lens = q("[data-zoom-lens]");
  const ghost = q("[data-zoom-ghost]");
  const app = q(".ace");
  const composer = q(".ace .composer");
  const placeholder = q(".ace .composer .placeholder");
  const column = q(".ace .column");
  const prompt = q('.ace .thread[data-for="cold-start"] .you');
  if (!stage || !world || !hero || !edge || !captions || !app || !composer || !column) return;

  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const things = [...root.querySelectorAll<HTMLElement>("[data-thing]")];
  const labels = [...root.querySelectorAll<HTMLElement>("[data-label]")];
  const verbs = [...root.querySelectorAll<HTMLElement>("[data-verb]")];
  const paths = [...root.querySelectorAll<SVGPathElement>("[data-link]")];
  const captionItems = [...captions.querySelectorAll<HTMLElement>("[data-caption]")];
  const promptText = prompt?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const emptyText = placeholder?.textContent ?? "";

  show(root, { thread: "cold-start" });
  // The copy of the composer that stands alone on the page at the start, prompt already typed.
  const copy = composer.cloneNode(true);
  if (ghost && copy instanceof HTMLElement) {
    const text = copy.querySelector(".placeholder");
    if (text) {
      text.textContent = promptText;
      text.classList.add("filled");
    }
    ghost.append(copy);
  }
  root.dataset.live = "";

  /** The camera's zoom right now, to turn what is on screen back into the drawing's own pixels. */
  let zoom = 1;

  /**
   * An element's box in the drawing's own pixels. Read from where it is on screen, since parts
   * of the drawn window are placed with transforms that layout offsets don't include.
   */
  const rectOf = (element: HTMLElement): Rect => {
    const origin = world.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return {
      x: (box.left - origin.left) / zoom,
      y: (box.top - origin.top) / zoom,
      width: box.width / zoom,
      height: box.height / zoom,
    };
  };

  let size: Size = { width: 1, height: 1 };
  let cameras: Camera[] = [];
  let boxes: Record<string, Rect> = {};
  let tops: Record<string, Rect> = {};
  let mids: { x: number; y: number }[] = [];
  let promptBox: Rect | undefined;

  function measure(): void {
    size = { width: stage.clientWidth, height: stage.clientHeight };
    boxes = Object.fromEntries(things.map((thing) => [thing.dataset.thing ?? "", rectOf(thing)]));
    // A label stands over the screen's corner; on a laptop that is narrower than its body.
    tops = Object.fromEntries(
      things.map((thing) => [
        thing.dataset.thing ?? "",
        rectOf(thing.querySelector<HTMLElement>("[data-lid]") ?? thing),
      ]),
    );
    const { mac, build, workstation, phone } = boxes;
    if (!mac || !build || !workstation || !phone) return;

    const side = Math.max(
      16,
      edge.getBoundingClientRect().left - stage.getBoundingClientRect().left,
    );
    const narrow = size.width < 760;
    // Clear of the header and a label above the top drawing, and of the captions below.
    const band = size.height - captions.offsetTop;
    stage.style.setProperty("--band", `${band}px`);
    const insets = { top: 64 + 44, right: side, bottom: band + 60, left: side };
    promptBox = rectOf(composer);
    if (ghost) ghost.style.width = `${promptBox.width}px`;
    const thread = rectOf(column);
    const shots: Record<(typeof shotOrder)[number], Shot> = {
      prompt: {
        rect: promptBox,
        insets: {
          top: hero.offsetTop + hero.offsetHeight + 32,
          right: side,
          bottom: 24,
          left: side,
        },
        maxScale: 0.92,
        alignX: 0,
        alignY: 0,
      },
      thread: {
        rect: { x: thread.x - 24, y: thread.y - 4, width: thread.width + 48, height: 404 },
        insets,
        maxScale: 1.1,
        minScale: narrow ? 0.5 : 0,
      },
      app: { rect: mac, insets },
      fleet: { rect: union([mac, build, workstation]), insets },
      phone: { rect: grow(phone, 60), insets, maxScale: 0.86 },
      all: { rect: union([mac, build, workstation, phone]), insets },
    };
    cameras = shotOrder.map((id) => frame(shots[id], size));

    mids = paths.map((path) => {
      // Lines run between screens, not between the wider bodies under them.
      const from = tops[path.dataset.from ?? ""];
      const to = tops[path.dataset.to ?? ""];
      if (!from || !to) return { x: 0, y: 0 };
      path.setAttribute("d", link(from, to));
      const half = path.getPointAtLength(path.getTotalLength() / 2);
      return { x: half.x, y: half.y };
    });
  }

  let applied: StoryState | undefined;

  /** Puts the drawing in the state the story has reached. Only what changed is touched. */
  function apply(state: StoryState): void {
    const was = applied;
    applied = state;
    if (state.sent !== was?.sent && placeholder) {
      placeholder.textContent = state.sent ? emptyText : promptText;
      placeholder.classList.toggle("filled", !state.sent);
    }
    if (state.lines !== was?.lines) app.dataset.lines = String(state.lines);
    if (state.agentsOpen !== was?.agentsOpen) {
      app.dataset.agents = state.agentsOpen ? "open" : "closed";
    }
    if (state.approval !== was?.approval) {
      const allowed = state.approval === "allowed";
      app.dataset.approved = allowed ? "yes" : "no";
      tone(root, "checkout", allowed ? "working" : "approve", allowed ? "4s" : "");
      q("[data-phone-note]")?.classList.toggle("on", state.approval === "asked");
    }
    if (state.done !== was?.done) {
      app.dataset.cold = state.done ? "done" : "running";
      tone(root, "cold-start", state.done ? "done" : "agents", state.done ? "now" : undefined);
      tone(root, "soak", state.done ? "done" : "working", state.done ? "now" : undefined);
      q("[data-phone]")?.setAttribute("data-activity", state.done ? "done" : "waiting");
      root.toggleAttribute("data-done", state.done);
    }
    if (state.machines !== was?.machines) {
      root.style.setProperty("--machines", state.machines.toFixed(3));
    }
    if (state.phone !== was?.phone) root.style.setProperty("--phone", state.phone.toFixed(3));
  }

  function render(progress: number): void {
    if (cameras.length !== shotOrder.length) return;
    const moving = legAt(progress, shotOrder.length);
    // Reduced motion: no travel, a cut to whichever shot is nearer.
    const t = still ? Math.round(moving.t) : moving.t;
    const leg = { ...moving, t, at: moving.from + t };
    const from = cameras[leg.from];
    const to = cameras[leg.to];
    if (!from || !to) return;
    const camera = between(from, to, leg.t, size);
    world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
    zoom = camera.scale;
    if (grid) {
      // The dotted ground sits far behind the drawing: it grows and slides a fraction as much.
      const step = 28 * camera.scale ** 0.3;
      grid.style.backgroundSize = `${step}px ${step}px`;
      grid.style.backgroundPosition = `${camera.x * 0.18}px ${camera.y * 0.18}px`;
    }
    for (const label of labels) {
      const box = tops[label.dataset.label ?? ""];
      if (!box) continue;
      const at = project(camera, box);
      label.style.transform = `translate(${at.x}px, ${at.y}px)`;
    }
    verbs.forEach((verb, index) => {
      const mid = mids[index];
      if (!mid) return;
      const at = project(camera, mid);
      verb.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -50%)`;
    });

    // The app fades in around the composer as the camera starts to pull back.
    const arrived = clamp(leg.at / 0.1);
    if (lens) lens.style.opacity = String(arrived);
    if (ghost && promptBox) {
      const at = project(camera, promptBox);
      ghost.style.transform = `translate(${at.x}px, ${at.y}px) scale(${camera.scale})`;
      ghost.style.visibility = arrived === 1 ? "hidden" : "";
    }

    const leaving = clamp(leg.at / 0.4);
    hero.style.opacity = String(1 - leaving);
    hero.style.transform = `translateY(${-leaving * 40}px)`;
    hero.style.visibility = leaving === 1 ? "hidden" : "";
    const shown = captionAt(leg) - 1;
    captionItems.forEach((item, index) => item.classList.toggle("on", index === shown));
    root.dataset.shot = shotOrder[captionAt(leg)];
    apply(storyAt(leg.at));
  }

  let target = 0;
  let shown = 0;
  let last = 0;
  let pending = 0;

  /** The camera eases toward the scroll position, so a wheel's steps become one steady move. */
  function tick(now: number): void {
    const elapsed = Math.min(64, now - last);
    last = now;
    const next = still ? target : shown + (target - shown) * (1 - Math.exp(-elapsed / 110));
    shown = Math.abs(target - next) < 0.0003 ? target : next;
    render(shown);
    pending = shown === target ? 0 : requestAnimationFrame(tick);
  }
  const wake = () => {
    if (pending) return;
    last = performance.now();
    pending = requestAnimationFrame(tick);
  };

  const remeasure = () => {
    measure();
    render(shown);
  };
  // The stage resizing, the stylesheet or fonts arriving late, or the layout switching between
  // side by side and stacked all move the drawings; each is measured again.
  const watcher = new ResizeObserver(remeasure);
  for (const element of [stage, hero, captions, composer, ...things]) watcher.observe(element);
  matchMedia("(max-width: 759px)").addEventListener("change", remeasure);
  addEventListener("load", remeasure);
  void document.fonts.ready.then(remeasure);
  remeasure();

  scroll(
    (progress: number) => {
      target = progress;
      wake();
    },
    { target: root, offset: ["start start", "end end"] },
  );
}
