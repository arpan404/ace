/*
 * The agents index's dial, as numbers: where it stands beside the composer and which agent a
 * key turns it to. The seats and the track come from the home page's own dial (zoom-camera.ts
 * `dialSeats`, `dialTrack`); this one is larger, so a reader can turn it by hand.
 */
import type { Dial, Rect } from "./zoom-camera.ts";

/** How far the chosen chip stands from the composer's edge, in pixels. */
export const rosterReach = 88;

/**
 * The dial beside a composer: the chosen chip level with the composer's middle and `reach` from
 * its right edge, its neighbours curving back toward it above and below.
 */
export function rosterDial(composer: Rect, reach = rosterReach): Dial {
  const radius = 236;
  return {
    cx: composer.x + composer.width + reach - radius,
    cy: composer.y + composer.height / 2,
    radius,
    step: (21 * Math.PI) / 180,
  };
}

/**
 * The agent a key turns the dial to, from `chosen` of `count`: down or right to the next, up or
 * left to the one before, wrapping round; Home and End to the ends. Any other key leaves it.
 */
export function turn(chosen: number, count: number, key: string): number | undefined {
  if (count < 1) return undefined;
  const by = (step: number) => (((chosen + step) % count) + count) % count;
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return by(1);
    case "ArrowUp":
    case "ArrowLeft":
      return by(-1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return undefined;
  }
}
