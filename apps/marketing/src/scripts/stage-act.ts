import { formatElapsed } from "@ace/ui-core/time";
import type { Act, Root } from "./stage-scenes.ts";

/*
 * What a scene of the drawn Mac acts through (stage-scenes.ts): the pointer moving to real
 * elements and pressing them, a finger tapping the Simulator, typing, and the agent's own
 * pointer in ace's browser. Shared by every story that plays the drawing. Positions are in
 * the desktop's own 1352 × 880 pixels; `scale` says how large the desktop is drawn right now.
 */

const q = (root: ParentNode, selector: string) => root.querySelector<HTMLElement>(selector);

export interface Stage {
  root: Root;
  /** The 1352 × 880 desktop the pointer moves over. */
  desk: HTMLElement;
  pointer: HTMLElement;
  /** Screen pixels per desktop pixel, now. */
  scale: () => number;
  /** Reduced motion: every wait is skipped, so a scene jumps to its end. */
  still: boolean;
}

/** Puts the pointer at a point on the desktop. */
export function placePointer(pointer: HTMLElement, x: number, y: number): void {
  pointer.style.setProperty("--x", `${x}px`);
  pointer.style.setProperty("--y", `${y}px`);
}

/** The acts for one run of a scene; `alive` turns false once a newer run starts. */
export function createAct(stage: Stage, alive: () => boolean): Act {
  const { root, desk, pointer, scale, still } = stage;

  /** A point inside `target` (fractions of its box), in the desktop's own pixels. */
  const pointIn = (target: Element | null, at = { x: 0.5, y: 0.5 }) => {
    const s = scale();
    const box = desk.getBoundingClientRect();
    if (!target) return { x: 1352 * at.x, y: 880 * at.y };
    const r = target.getBoundingClientRect();
    return {
      x: (r.left - box.left + r.width * at.x) / s,
      y: (r.top - box.top + r.height * at.y) / s,
    };
  };

  const wait = (ms: number) =>
    new Promise<void>((done) => setTimeout(done, still || !alive() ? 0 : ms));
  const moveTo = async (target: Element | null, at?: { x: number; y: number }) => {
    if (!alive()) return;
    const p = pointIn(target, at);
    pointer.classList.add("shown");
    placePointer(pointer, p.x, p.y);
    await wait(900);
  };

  return {
    alive,
    wait,
    moveTo,
    async click(target) {
      await moveTo(target, { x: 0.35, y: 0.5 });
      if (!alive()) return;
      pointer.classList.add("press");
      target?.classList.add("pressed");
      await wait(160);
      pointer.classList.remove("press");
      target?.classList.remove("pressed");
    },
    async tap(target) {
      if (!alive() || !target) return;
      const touch = q(root, "[data-touch]");
      const sim = q(root, "[data-sim]");
      if (!touch || !sim) return;
      const s = scale();
      const r = target.getBoundingClientRect();
      const frame = sim.getBoundingClientRect();
      touch.style.left = `${(r.left - frame.left + r.width / 2) / s}px`;
      touch.style.top = `${(r.top - frame.top + r.height / 2) / s}px`;
      await wait(500);
      touch.classList.add("down");
      for (const field of root.querySelectorAll(".field.focus")) field.classList.remove("focus");
      if (target.classList.contains("field")) target.classList.add("focus");
      await wait(220);
      touch.classList.remove("down");
      await wait(250);
    },
    async agentTo(target) {
      const cursor = q(root, "[data-agent-cursor]");
      const site = q(root, ".site");
      if (!alive() || !cursor || !site || !target) return;
      const s = scale();
      const r = target.getBoundingClientRect();
      const page = site.getBoundingClientRect();
      cursor.classList.add("shown");
      cursor.style.setProperty("--ax", `${(r.left - page.left + r.width * 0.55) / s}px`);
      cursor.style.setProperty("--ay", `${(r.top - page.top + r.height * 0.4) / s}px`);
      await wait(950);
    },
    hidePointer() {
      pointer.classList.remove("shown");
    },
    async type(target, text, mask = false) {
      if (!target) return;
      for (let i = 1; i <= text.length; i++) {
        if (!alive()) return;
        target.textContent = mask ? "•".repeat(i) : text.slice(0, i);
        await wait(55);
      }
    },
  };
}

/** Running times tick once a second, like the app's, while the page is visible. */
export function tickClocks(root: Root): void {
  const clocks = [...root.querySelectorAll<HTMLElement>("[data-seconds]")];
  setInterval(() => {
    if (document.hidden) return;
    for (const clock of clocks) {
      // A row that finished, waits on you or hit a limit shows no running time.
      if (clock.closest('[data-tone="done"], [data-tone="approve"], [data-tone="limited"]'))
        continue;
      const seconds = Number(clock.dataset.seconds) + 1;
      clock.dataset.seconds = String(seconds);
      clock.textContent = formatElapsed(seconds * 1000);
    }
  }, 1000);
}
