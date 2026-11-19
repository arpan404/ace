import type { StepFocus, StepMove, StepPart } from "../content/features.ts";
import type { CastId } from "./feature-camera.ts";

/*
 * A feature page's steps, as decisions: what the drawing should be doing on a step, and
 * whether its camera shows whole hardware or one part of ace's window. Nothing here touches
 * the page; scripts/feature-story.ts applies the answers.
 */

/** What a step needs from the drawing, as the page hands it to the script. */
export interface StepPlan {
  move: StepMove;
  focus: StepFocus;
}

export type PlayedMove = Exclude<StepMove, "keep">;

/**
 * The move the drawing should be in on step `index`. `keep` carries on from the nearest step
 * before it that names one, so a reader who lands mid-story still sees the right state; a
 * story that opens with `keep` starts from rest.
 */
export function moveAt(plan: readonly StepPlan[], index: number): PlayedMove {
  for (let at = Math.min(index, plan.length - 1); at >= 0; at--) {
    const move = plan[at]?.move;
    if (move && move !== "keep") return move;
  }
  return "rest";
}

/**
 * Whether entering step `index` from the step that played `playing` starts a move: only when
 * the step asks for a different one, so scrolling within a run of `keep` steps lets the scene
 * that is playing go on.
 */
export function startsMove(
  plan: readonly StepPlan[],
  index: number,
  playing: PlayedMove | undefined,
): PlayedMove | undefined {
  const move = moveAt(plan, index);
  return move === playing ? undefined : move;
}

const cast: readonly string[] = ["mac", "build", "workstation", "phone"] satisfies CastId[];
const parts: readonly string[] = [
  "window",
  "threads",
  "thread",
  "canvas",
  "dock",
  "changes",
  "diff",
  "commit",
  "browser",
  "sim",
] satisfies StepPart[];

const isCast = (id: string): id is CastId => cast.includes(id);
const isPart = (id: string): id is StepPart => parts.includes(id);

/** A step's focus, sorted: the hardware it frames, or the one part of the window. */
export function readFocus(
  focus: StepFocus,
): { kind: "device"; cast: CastId[] } | { kind: "part"; part: StepPart } {
  const ids: readonly string[] = focus;
  const devices = ids.filter(isCast);
  const part = ids.find(isPart);
  if (part && devices.length === 0) return { kind: "part", part };
  return { kind: "device", cast: devices.length > 0 ? devices : ["mac"] };
}

/**
 * The hardware on stage at step `index`: what that step frames, or the Mac alone when it frames
 * a part of ace's window. Other machines stay off stage, hidden and outside the camera, until a
 * step is about them, and leave again on a step about the Mac alone, so a shot of the Mac never
 * shows a sliver of them. A step about one other device stands it alone.
 */
export function onStage(
  plan: readonly StepPlan[],
  index: number,
  standing: readonly CastId[],
): CastId[] {
  const step = plan[Math.min(index, plan.length - 1)];
  const focus = step ? readFocus(step.focus) : undefined;
  const framed: readonly CastId[] = focus?.kind === "device" ? focus.cast : ["mac"];
  const on = standing.filter((id) => framed.includes(id));
  return on.length > 0 ? on : standing.filter((id) => id === "mac");
}
