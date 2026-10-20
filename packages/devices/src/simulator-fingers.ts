import { DeviceError } from "./sdk.ts";

/** A point normalized to the simulator framebuffer, 0..1 on each axis. */
export type FingerPoint = { x: number; y: number };
type Finger = { finger: 0 | 1; point: FingerPoint };

/**
 * The fingers held on a simulator. serve-sim takes one touch (with an optional system-edge
 * flag) or one two-finger touch, so fingers 0 and 1 are the only ones it can hold. A pair keeps
 * the finger that came down first in the first slot. A finger left down after a two-finger
 * touch is `resting`: it reaches serve-sim again only once it moves.
 */
export type HeldFingers =
  | { kind: "none" }
  | ({ kind: "one"; edge: number; resting?: true } & Finger)
  | { kind: "two"; pair: readonly [Finger, Finger] };

type Phase = "begin" | "move" | "end";
/** One serve-sim control message: tag 3 is a single touch, tag 5 a two-finger touch. */
export type FingerMessage =
  | { tag: 3; payload: { type: Phase; x: number; y: number; edge?: number } }
  | { tag: 5; payload: { type: Phase; x1: number; y1: number; x2: number; y2: number } };

export type FingerStep = { held: HeldFingers; messages: FingerMessage[] };

export const noFingers: HeldFingers = { kind: "none" };

/** Pointer ids beyond the second finger have no serve-sim touch to map to. */
export function simulatorFinger(pointerId: number | undefined): 0 | 1 {
  const id = pointerId ?? 0;
  if (id === 0 || id === 1) return id;
  throw new DeviceError(
    "not_supported",
    "iOS Simulator input supports at most two fingers",
    "Use pointerId 0 or 1.",
  );
}

/**
 * A finger touches down. A second finger turns the held touch into a two-finger touch with no
 * lift in between: lifting the first finger there would reach iOS as a tap.
 */
export function fingerDown(
  held: HeldFingers,
  finger: 0 | 1,
  point: FingerPoint,
  edge: number,
): FingerStep {
  if (held.kind === "one" && held.finger !== finger) {
    const pair = [
      { finger: held.finger, point: held.point },
      { finger, point },
    ] as const;
    return { held: { kind: "two", pair }, messages: [pairMessage("begin", pair)] };
  }
  if (held.kind === "two") {
    const pair = moved(held.pair, finger, point);
    return {
      held: { kind: "two", pair },
      messages: [pairMessage("end", held.pair), pairMessage("begin", pair)],
    };
  }
  return {
    held: { kind: "one", finger, point, edge },
    messages: [...endFingers(held), single("begin", point, edge)],
  };
}

/** A held finger moves; moving a finger that is not down is a caller error. */
export function fingerMove(held: HeldFingers, finger: 0 | 1, point: FingerPoint): FingerStep {
  if (held.kind === "two") {
    const pair = moved(held.pair, finger, point);
    return { held: { kind: "two", pair }, messages: [pairMessage("move", pair)] };
  }
  if (held.kind === "one" && held.finger === finger)
    return {
      held: { kind: "one", finger, point, edge: held.edge },
      messages: [
        ...(held.resting ? [single("begin", held.point, held.edge)] : []),
        single("move", point, held.edge),
      ],
    };
  throw new Error("Simulator pointer is not held");
}

/**
 * A finger lifts. Lifting one of two fingers ends the two-finger touch; the other finger rests
 * until it moves, so lifting it straight after (fingers rarely lift together) is not a tap.
 * Lifting a finger that is not down does nothing.
 */
export function fingerUp(held: HeldFingers, finger: 0 | 1): FingerStep {
  if (held.kind === "two") {
    const [first, second] = held.pair;
    const other = first.finger === finger ? second : first;
    return {
      held: { kind: "one", ...other, edge: 0, resting: true },
      messages: [pairMessage("end", held.pair)],
    };
  }
  if (held.kind === "one" && held.finger === finger)
    return { held: noFingers, messages: endFingers(held) };
  return { held, messages: [] };
}

/** The messages that lift every held finger. */
export function endFingers(held: HeldFingers): FingerMessage[] {
  if (held.kind === "one") return held.resting ? [] : [single("end", held.point, held.edge)];
  if (held.kind === "two") return [pairMessage("end", held.pair)];
  return [];
}

function moved(
  pair: readonly [Finger, Finger],
  finger: 0 | 1,
  point: FingerPoint,
): readonly [Finger, Finger] {
  const [first, second] = pair;
  return first.finger === finger ? [{ finger, point }, second] : [first, { finger, point }];
}

function single(type: Phase, point: FingerPoint, edge: number): FingerMessage {
  return {
    tag: 3,
    payload: edge ? { type, x: point.x, y: point.y, edge } : { type, x: point.x, y: point.y },
  };
}

function pairMessage(type: Phase, pair: readonly [Finger, Finger]): FingerMessage {
  const [first, second] = pair;
  return {
    tag: 5,
    payload: {
      type,
      x1: first.point.x,
      y1: first.point.y,
      x2: second.point.x,
      y2: second.point.y,
    },
  };
}
