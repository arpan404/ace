/*
 * The home page's zoom-out story, as numbers: where the camera sits for a given scroll position
 * and what has happened in the story by then. Nothing here touches the page; scripts/zoom-story.ts
 * measures the drawing, asks these functions, and applies the answers.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Stage pixels a shot keeps clear on each side, for the header and the captions. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** World pixels become stage pixels: `stage = world * scale + (x, y)`. */
export interface Camera {
  scale: number;
  x: number;
  y: number;
}

export interface Shot {
  /** The part of the world to show, in world pixels. */
  rect: Rect;
  insets: Insets;
  /** Never drawn larger than this, so a small subject isn't blown up. */
  maxScale?: number;
  /**
   * Never drawn smaller than this. A subject too wide for the stage then runs off its far
   * edge instead of shrinking past reading size.
   */
  minScale?: number;
  /** Where the subject sits in the free area: 0 at its start, 1 at its end. Centred by default. */
  alignX?: number;
  alignY?: number;
}

const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const lerp = (from: number, to: number, t: number) => from + (to - from) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);

/** The smallest rectangle holding every one of `rects`. */
export function union(rects: readonly Rect[]): Rect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The camera that shows a shot's subject inside the stage's free area. */
export function frame(shot: Shot, stage: Size): Camera {
  const { rect, insets } = shot;
  const free = {
    width: Math.max(1, stage.width - insets.left - insets.right),
    height: Math.max(1, stage.height - insets.top - insets.bottom),
  };
  const contain = Math.min(free.width / rect.width, free.height / rect.height);
  const scale = Math.max(shot.minScale ?? 0, Math.min(shot.maxScale ?? Infinity, contain));
  // A subject wider than the free area starts at its leading edge, never centred off both sides.
  const spareX = free.width - rect.width * scale;
  const spareY = free.height - rect.height * scale;
  const alignX = spareX < 0 ? 0 : (shot.alignX ?? 0.5);
  const alignY = spareY < 0 ? 0 : (shot.alignY ?? 0.5);
  return {
    scale,
    x: insets.left + spareX * alignX - rect.x * scale,
    y: insets.top + spareY * alignY - rect.y * scale,
  };
}

/**
 * The camera part of the way from one shot to the next. Zoom changes by ratio, and the pan
 * slows as the picture grows, so the move reads as one steady pull instead of a whip at the
 * zoomed-in end.
 */
export function between(from: Camera, to: Camera, t: number, stage: Size): Camera {
  if (t <= 0) return from;
  if (t >= 1) return to;
  const ratio = to.scale / from.scale;
  const scale = from.scale * ratio ** t;
  const travelled = Math.abs(ratio - 1) < 1e-6 ? t : (1 - ratio ** -t) / (1 - 1 / ratio);
  const centre = (camera: Camera) => ({
    x: (stage.width / 2 - camera.x) / camera.scale,
    y: (stage.height / 2 - camera.y) / camera.scale,
  });
  const a = centre(from);
  const b = centre(to);
  return {
    scale,
    x: stage.width / 2 - lerp(a.x, b.x, travelled) * scale,
    y: stage.height / 2 - lerp(a.y, b.y, travelled) * scale,
  };
}

/** A world point as the camera shows it on the stage. */
export function project(camera: Camera, point: { x: number; y: number }): { x: number; y: number } {
  return { x: point.x * camera.scale + camera.x, y: point.y * camera.scale + camera.y };
}

export interface Leg {
  /** The shot the camera leaves and the one it heads for. */
  from: number;
  to: number;
  /** How far along the move it is, eased: 0 resting on `from`, 1 resting on `to`. */
  t: number;
  /** The same position as one number: 2.5 is halfway between the third and fourth shots. */
  at: number;
}

/**
 * Splits the scroll through the story into moves between `shots` shots. The camera rests on
 * each shot for `rest` of a move's scroll distance, half before leaving and half after arriving,
 * so every caption gets a still moment to be read.
 */
export function legAt(progress: number, shots: number, rest = 0.4): Leg {
  const moves = Math.max(1, shots - 1);
  const position = clamp(progress) * moves;
  const from = Math.min(moves - 1, Math.floor(position));
  const local = position - from;
  const t = smooth(clamp((local - rest / 2) / (1 - rest)));
  return { from, to: from + 1, t, at: from + t };
}

/** The shot whose caption shows: the one the camera is nearer to. */
export function captionAt(leg: Leg): number {
  return leg.t < 0.5 ? leg.from : leg.to;
}

/** The story's shots, in order. */
export const shotOrder = ["prompt", "thread", "app", "fleet", "phone", "all"] as const;
export type ShotId = (typeof shotOrder)[number];

export interface StoryState {
  /** The prompt has left the composer and become a thread. */
  sent: boolean;
  /** How many lines of the thread have appeared, of four. */
  lines: number;
  /** The thread's list of agents is open. */
  agentsOpen: boolean;
  /** The other machines and the lines to them are drawn, 0 to 1. */
  machines: number;
  /** The phone is in the picture, 0 to 1. */
  phone: number;
  /** The approval another thread asked for: not yet, on the Lock Screen, or allowed. */
  approval: "none" | "asked" | "allowed";
  /** Every agent has finished, so the thread shows as done. */
  done: boolean;
}

/**
 * What has happened by a point in the story (`Leg.at`). Order is the product's own: agents
 * are handed work before they are listed, an approval is asked before it is allowed, and the
 * thread is done only at the very end, after everything under it.
 */
export function storyAt(at: number): StoryState {
  const span = (start: number, end: number) => clamp((at - start) / (end - start));
  return {
    sent: at >= 0.12,
    lines: at < 0.25 ? 0 : at < 0.45 ? 1 : at < 0.62 ? 2 : at < 0.8 ? 3 : 4,
    agentsOpen: at >= 0.92,
    machines: span(2.2, 2.75),
    phone: span(3.05, 3.5),
    approval: at < 3.7 ? "none" : at < 4.35 ? "asked" : "allowed",
    done: at >= 4.8,
  };
}

/** A line from one drawing to another, leaving and arriving on the sides that face each other. */
export function link(from: Rect, to: Rect): string {
  const centre = (rect: Rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  const a = centre(from);
  const b = centre(to);
  const sideways = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
  if (sideways) {
    const forward = b.x > a.x;
    const x1 = forward ? from.x + from.width : from.x;
    const x2 = forward ? to.x : to.x + to.width;
    const bend = (x2 - x1) / 2;
    return `M${x1} ${a.y}C${x1 + bend} ${a.y} ${x2 - bend} ${b.y} ${x2} ${b.y}`;
  }
  const down = b.y > a.y;
  const y1 = down ? from.y + from.height : from.y;
  const y2 = down ? to.y : to.y + to.height;
  const bend = (y2 - y1) / 2;
  return `M${a.x} ${y1}C${a.x} ${y1 + bend} ${b.x} ${y2 - bend} ${b.x} ${y2}`;
}

export interface Tree {
  /** Top left corner of each chip, in stage pixels. */
  leaves: { x: number; y: number }[];
  /** One line per chip, from the composer to the chip's left edge. */
  lines: string[];
}

/**
 * The opening's picture of "a whole team out": a tree growing from the composer, one branch
 * per agent, drawn the way ace draws a thread's agents. On a wide screen the chips stand in a
 * column at the right edge and the trunk leaves the composer's side; on a narrow one they hang
 * under it. Returns nothing when a wide screen has no room beside the composer.
 */
export function teamTree(
  composer: Rect,
  stage: Size,
  side: number,
  count: number,
  chip: Size,
  narrow: boolean,
): Tree | undefined {
  const radius = 14;
  const bottom = composer.y + composer.height;
  if (narrow) {
    const trunk = composer.x + 18;
    const x = trunk + 30;
    const leaves = Array.from({ length: count }, (_, index) => ({
      x,
      y: bottom + 60 + index * (chip.height + 10),
    }));
    return {
      leaves,
      lines: leaves.map((leaf) => {
        const y = leaf.y + chip.height / 2;
        return `M${trunk} ${bottom}V${y - radius}Q${trunk} ${y} ${trunk + radius} ${y}H${leaf.x}`;
      }),
    };
  }

  const right = composer.x + composer.width;
  const x = stage.width - side - chip.width;
  if (x - right < 96) return undefined;
  const trunk = right + (x - right) * 0.42;
  const from = composer.y + composer.height / 2;
  const top = 116;
  const last = bottom - chip.height;
  const step = count > 1 ? (last - top) / (count - 1) : 0;
  const leaves = Array.from({ length: count }, (_, index) => ({ x, y: top + step * index }));
  return {
    leaves,
    lines: leaves.map((leaf) => {
      const y = leaf.y + chip.height / 2;
      const rise = y - from;
      // A branch level with the composer runs straight; the others turn twice.
      if (Math.abs(rise) < radius * 2)
        return `M${right} ${from}C${trunk} ${from} ${trunk} ${y} ${x} ${y}`;
      const turn = Math.sign(rise) * radius;
      return `M${right} ${from}H${trunk - radius}Q${trunk} ${from} ${trunk} ${from + turn}V${y - turn}Q${trunk} ${y} ${trunk + radius} ${y}H${x}`;
    }),
  };
}
