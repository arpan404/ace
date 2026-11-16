import type { SceneSignal } from "@ace/protocol/suits";
import { sceneSignals, type SignalSnapshot } from "./scene-signals.ts";

/*
 * A Suit's celebration (ADR 0150, `scenes.celebration`): a full-window scene ace shows ABOVE the
 * UI for a moment, when the open thread's run finishes or a pull request merges. These are its
 * rules; `celebration-layer.tsx` is the I/O around them. Pure: time comes in.
 *
 * - It plays for at most `celebrationMaxMs`, at most once per `celebrationGapMs`, never under
 *   Reduce motion and never on a hidden page.
 * - It never covers ace's protected parts (the approval strip, the Working line, question cards,
 *   status icons). Those sit inside stacking contexts of their own (the shell's isolation, the
 *   composer, sheets and menus portaled to the body), so no z-index could slide the layer between
 *   them and what's around them. Instead the layer sits above everything and its `clip-path`
 *   cuts a hole around each protected part's box, measured while it plays.
 */

export const celebrationMaxMs = 4000;
export const celebrationGapMs = 10_000;
/** Room left around each protected part, CSS px, so a glow or confetti never touches its edge. */
export const celebrationClearance = 6;
/** How often the holes are measured again while it plays: the transcript may scroll under it. */
export const celebrationMeasureMs = 100;

export type CelebrationCue = Extract<SceneSignal, "done" | "pr-merged">;

/**
 * What a change in the thread list celebrates: a linked pull request that merged (any of the
 * person's threads, as `sceneSignals` counts it), else the open thread's run finishing (it was
 * known in another state and is now done). A merge outranks a finish when both land at once.
 */
export function celebrationCue(
  previous: SignalSnapshot,
  next: SignalSnapshot,
  openThreadId: string | undefined,
): CelebrationCue | undefined {
  if (sceneSignals(previous, next).includes("pr-merged")) return "pr-merged";
  if (openThreadId === undefined) return undefined;
  const before = previous.states.get(openThreadId);
  const now = next.states.get(openThreadId);
  return before !== undefined && before !== "done" && now === "done" ? "done" : undefined;
}

export interface CelebrationFacts {
  /** The Suit names a celebration scene and the watchdog hasn't stopped it. */
  hasScene: boolean;
  reduceMotion: boolean;
  visible: boolean;
}

/** Decides whether a cue plays: once per gap, and only when it may be seen and may move. */
export function createCelebrationGate(clock: { now(): number }) {
  let lastAt = Number.NEGATIVE_INFINITY;
  return {
    admit(facts: CelebrationFacts): boolean {
      if (!facts.hasScene || facts.reduceMotion || !facts.visible) return false;
      const now = clock.now();
      if (now - lastAt < celebrationGapMs) return false;
      lastAt = now;
      return true;
    },
  };
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const round = (value: number) => Math.round(value * 2) / 2;

/**
 * The layer's `clip-path`: the whole window less a hole around each box (grown by `clearance`),
 * as one even-odd path. Holes that overlap merge their area rather than cancelling out, so two
 * neighbouring parts never show the scene between them: boxes are merged before they're cut.
 * Empty boxes and boxes wholly off screen are left out; with none left it is `none`.
 */
export function celebrationClip(
  boxes: readonly Box[],
  view: { width: number; height: number },
  clearance = celebrationClearance,
): string {
  const grown = boxes
    .filter((box) => box.width > 0 && box.height > 0)
    .map((box) => ({
      left: Math.max(0, box.left - clearance),
      top: Math.max(0, box.top - clearance),
      right: Math.min(view.width, box.left + box.width + clearance),
      bottom: Math.min(view.height, box.top + box.height + clearance),
    }))
    .filter((box) => box.right > box.left && box.bottom > box.top);
  const merged = mergeOverlapping(grown);
  if (merged.length === 0) return "none";
  const outer = `M0 0H${round(view.width)}V${round(view.height)}H0Z`;
  const holes = merged
    .map(
      (box) =>
        `M${round(box.left)} ${round(box.top)}H${round(box.right)}V${round(box.bottom)}H${round(box.left)}Z`,
    )
    .join("");
  return `path(evenodd, "${outer}${holes}")`;
}

interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Overlapping rectangles joined into their bounding boxes until none overlap. */
function mergeOverlapping(boxes: Edges[]): Edges[] {
  const out = boxes.map((box) => ({ ...box }));
  for (let changed = true; changed;) {
    changed = false;
    outer: for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i];
        const b = out[j];
        if (!a || !b) continue;
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
          out[i] = {
            left: Math.min(a.left, b.left),
            top: Math.min(a.top, b.top),
            right: Math.max(a.right, b.right),
            bottom: Math.max(a.bottom, b.bottom),
          };
          out.splice(j, 1);
          changed = true;
          break outer;
        }
      }
  }
  return out;
}
