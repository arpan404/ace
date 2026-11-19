import { frame, union, type Camera, type Insets, type Rect, type Size } from "./zoom-camera.ts";

/*
 * A feature page's story, as numbers: where each piece of hardware stands, which arrangement
 * suits the frame it is shown in, and the camera for a step, whether it shows a whole device or
 * zooms to one part of ace's window. Nothing here touches the page; scripts/feature-story.ts
 * measures the drawing, asks these functions and applies the answers.
 */

/** The hardware a feature page can stand in its picture. */
export type CastId = "mac" | "build" | "workstation" | "phone";

/** Each drawing's size in the world's pixels (the app's own, so a Mac's screen is 1352 wide). */
export const castSizes: Record<CastId, Size> = {
  mac: { width: 1616, height: 968 },
  build: { width: 760, height: 462 },
  workstation: { width: 700, height: 500 },
  phone: { width: 330, height: 700 },
};

/** Side by side for a frame wider than tall, stacked under the Mac for one taller than wide. */
export type Layout = "wide" | "tall";

/** World pixels between two drawings. */
const gap = 120;

/**
 * Where each drawing stands. The Mac is always at the origin. Side by side, the other machines
 * stack in a column to its right and the phone stands at its left, all resting on the same
 * table as the Mac; with no other machine, the phone stands at its right. Stacked, everything
 * else stands in one row under the Mac, centred on it.
 */
export function arrange(cast: readonly CastId[], layout: Layout): Partial<Record<CastId, Rect>> {
  const mac = castSizes.mac;
  const places: Partial<Record<CastId, Rect>> = { mac: { x: 0, y: 0, ...mac } };
  const others = cast.filter((id) => id !== "mac");
  if (others.length === 0) return places;

  if (layout === "tall") {
    const sizes = others.map((id) => castSizes[id]);
    const width = sizes.reduce((sum, size) => sum + size.width, 0) + gap * (others.length - 1);
    const height = Math.max(...sizes.map((size) => size.height));
    let x = (mac.width - width) / 2;
    others.forEach((id) => {
      const size = castSizes[id];
      places[id] = { x, y: mac.height + gap + height - size.height, ...size };
      x += size.width + gap;
    });
    return places;
  }

  const machines = others.filter((id) => id !== "phone");
  const phone = castSizes.phone;
  if (others.includes("phone")) {
    const x = machines.length > 0 ? -gap - phone.width : mac.width + gap;
    places.phone = { x, y: mac.height - phone.height, ...phone };
  }
  const column = machines.reduce((sum, id) => sum + castSizes[id].height, 0);
  let y = mac.height - column - gap * (machines.length - 1);
  for (const id of machines) {
    const size = castSizes[id];
    places[id] = { x: mac.width + gap, y, ...size };
    y += size.height + gap;
  }
  return places;
}

/**
 * Where the stage fades out, in stage pixels from each edge: the picture is masked to nothing at
 * the edge and fully drawn this far in, so nothing is cut off by a hard line. The top clears the
 * floating header first. A band across the top of a phone or tablet (a short stage) fades less,
 * so its little height goes to the picture.
 */
export function stageFade(stage: Size): Insets & { header: number } {
  const band = stage.height < 600;
  return {
    header: band ? 56 : 60,
    top: band ? 84 : 104,
    right: band ? 16 : 56,
    bottom: band ? 20 : 72,
    left: band ? 16 : 104,
  };
}

const add = (a: Insets, b: Insets): Insets => ({
  top: a.top + b.top,
  right: a.right + b.right,
  bottom: a.bottom + b.bottom,
  left: a.left + b.left,
});

/** Room a whole-device shot keeps clear inside the fade: a label stands above each drawing. */
const deviceInsets = { top: 32, right: 8, bottom: 8, left: 8 };

/** How large the whole picture is drawn in a frame, for comparing arrangements. */
function fit(rects: Rect[], stage: Size): number {
  const all = union(rects);
  const insets = add(stageFade(stage), deviceInsets);
  const width = stage.width - insets.left - insets.right;
  const height = stage.height - insets.top - insets.bottom;
  return Math.min(width / all.width, height / all.height);
}

/** The arrangement that shows the whole cast largest in this frame; side by side on a tie. */
export function chooseLayout(cast: readonly CastId[], stage: Size): Layout {
  const sizeIn = (layout: Layout) =>
    fit(
      Object.values(arrange(cast, layout)).filter((rect) => rect !== undefined),
      stage,
    );
  return sizeIn("tall") > sizeIn("wide") * 1.02 ? "tall" : "wide";
}

/** What a step's camera shows: whole devices, or one part of ace's window. */
export type FocusKind = "device" | "part";

/** World pixels of room kept around a part of the window, so it doesn't touch the frame. */
const partMargin = 24;
/** A part is drawn at most this much larger than life, so it never turns into a blur. */
const partMaxScale = 1.1;

/**
 * Stage pixels of room around a part, beyond the fade: a tenth of the stage's smaller side (at most 72), so
 * the part sits whole and centred with what surrounds it plainly secondary.
 */
function partRoom(stage: Size): Insets {
  const room = Math.min(72, Math.max(12, Math.min(stage.width, stage.height) / 10));
  return { top: room, right: room, bottom: room, left: room };
}

/** The camera for a step: `rect` is what it shows, in world pixels, inside the fade. */
export function shotCamera(rect: Rect, kind: FocusKind, stage: Size): Camera {
  const fade = stageFade(stage);
  if (kind === "device") {
    return frame({ rect, insets: add(fade, deviceInsets), maxScale: 1 }, stage);
  }
  const padded = {
    x: rect.x - partMargin,
    y: rect.y - partMargin,
    width: rect.width + partMargin * 2,
    height: rect.height + partMargin * 2,
  };
  return frame({ rect: padded, insets: add(fade, partRoom(stage)), maxScale: partMaxScale }, stage);
}

/** How long the camera takes to travel between two steps, in milliseconds. */
export const travel = 1100;

/** Eased progress of a camera move `elapsed` milliseconds in: slow out, slow in. */
export function travelled(elapsed: number, duration = travel): number {
  const t = Math.min(1, Math.max(0, elapsed / duration));
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}
