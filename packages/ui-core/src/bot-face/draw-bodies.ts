import type { BotBody } from "./model.ts";
import { INK, PAPER, n, type BodyShape, type FaceTier } from "./draw-shared.ts";

/* The ten bodies: silhouettes, where the face sits on each, and their own parts. */

function ghostHem(tier: FaceTier): string {
  const width = tier === "s" ? 6 : 3;
  const ry = tier === "s" ? 1.6 : 1.05;
  let d = "";
  for (let x = 21; x > 3.01; x -= width) d += `A${width / 2} ${ry} 0 0 1 ${n(x - width)} 20.2`;
  return d;
}

export const BODIES: Record<BotBody, BodyShape> = {
  round: {
    shapes: () => `<circle cx="12" cy="12" r="10.6"/>`,
    eyeY: 11.9,
    mouthY: 17.6,
    top: [12, 1.4],
    left: 1.4,
    right: 22.6,
    cheekY: 15.7,
    cheekDx: 6.9,
    light: [7.4, 5.6],
  },
  blob: {
    shapes: () =>
      `<path d="M12 2.6C17.7 2.6 21.7 6.6 21.9 12.6 22.1 18.6 18.3 22.2 12 22.2S1.9 18.6 2.1 12.6C2.3 6.6 6.3 2.6 12 2.6Z"/>` +
      `<path d="M12.2 3.2C11.6 1.2 12.9-0.2 14.9 0.3 13.6 0.8 13.2 1.8 13.8 3.1Z"/>`,
    eyeY: 12.6,
    mouthY: 18.2,
    top: [12, 2.6],
    left: 2.1,
    right: 21.9,
    cheekY: 16.3,
    cheekDx: 6.8,
    light: [7.2, 6.4],
  },
  pebble: {
    shapes: () =>
      `<path d="M12.6 3.4C18.6 3.3 22.7 7.6 22.6 13.2 22.5 18.6 18.4 22.1 12 22.1S1.3 18.6 1.4 13.4C1.5 7.8 6.4 3.5 12.6 3.4Z"/>`,
    eyeY: 12.8,
    mouthY: 18.3,
    top: [12.4, 3.4],
    left: 1.4,
    right: 22.6,
    cheekY: 16.5,
    cheekDx: 7.2,
    light: [7.4, 6.8],
    front: (t) =>
      t === "s"
        ? ""
        : `<g fill="var(--bs)"><circle cx="18.2" cy="18" r=".7"/><circle cx="19.7" cy="15.8" r=".45"/><circle cx="5" cy="18.3" r=".5"/></g>`,
  },
  sprout: {
    shapes: () => `<circle cx="12" cy="13.4" r="9.5"/>`,
    eyeY: 13.3,
    mouthY: 18.7,
    top: [12, 3.9],
    left: 2.5,
    right: 21.5,
    cheekY: 17,
    cheekDx: 6.4,
    light: [7.8, 7.4],
    back: (t) =>
      `<path d="M12 4.6C11.9 3.4 12 2.6 12.3 1.9" fill="none" stroke="var(--as)" stroke-width="${t === "s" ? 1.3 : 1}" stroke-linecap="round"/>` +
      `<path d="M12.2 2.4C10.8 0 7.6-0.5 5.9 0.6 7.1 2.9 9.9 3.5 12.2 2.4Z" fill="var(--a)"/>` +
      `<path d="M12.2 2.2C13.2-0.9 16.8-1.9 19.1-0.7 17.9 2.1 14.8 3.1 12.2 2.2Z" fill="var(--a)"/>` +
      (t === "s"
        ? ""
        : `<path d="M12.6 1.9C14.4 0.6 16.2 0 18 -0.3M11.7 2.1C10.2 1.2 8.6 0.8 7.1 0.8" fill="none" stroke="var(--as)" stroke-width=".55" stroke-linecap="round"/>`),
  },
  ghost: {
    shapes: (t) => `<path d="M3 12.4C3 6.7 7 2.6 12 2.6S21 6.7 21 12.4V20.2${ghostHem(t)}Z"/>`,
    eyeY: 11.6,
    mouthY: 16.6,
    top: [12, 2.6],
    left: 3,
    right: 21,
    cheekY: 14.9,
    cheekDx: 6,
    light: [7.6, 6],
  },
  bot: {
    shapes: () => `<rect x="2.6" y="4.4" width="18.8" height="17" rx="6.2"/>`,
    eyeY: 12.4,
    mouthY: 19.1,
    top: [12, 4.4],
    left: 2.6,
    right: 21.4,
    cheekY: 18.6,
    cheekDx: 6.6,
    light: [6.8, 7],
    lid: "var(--visor)",
    back: (t) =>
      `<path d="M12 4.6V2.4" stroke="var(--as)" stroke-width="${t === "s" ? 1.4 : 1.05}" stroke-linecap="round"/>` +
      `<circle cx="12" cy="1.5" r="${t === "s" ? 1.6 : 1.4}" fill="var(--a)"/>` +
      `<rect x="0.7" y="10" width="2.6" height="5.6" rx="1.3" fill="var(--a)"/><rect x="20.7" y="10" width="2.6" height="5.6" rx="1.3" fill="var(--a)"/>`,
    front: (t) =>
      `<rect x="4.4" y="7.3" width="15.2" height="10.2" rx="5.1" fill="var(--visor)"/>` +
      (t === "l"
        ? `<path d="M6.6 9.4C7.2 8.6 8.2 8.3 9.4 8.3" fill="none" stroke="${PAPER}" stroke-opacity=".35" stroke-width=".55" stroke-linecap="round"/>`
        : ""),
  },
  fox: {
    shapes: () =>
      `<path d="M3.7 10.4 3.5 1.9C3.5 1.2 4.1 1 4.6 1.3L10.6 5.4ZM20.3 10.4 20.5 1.9C20.5 1.2 19.9 1 19.4 1.3L13.4 5.4Z"/>` +
      `<path d="M12 4.3C17.6 4.3 21.3 8.2 21.3 13.1 21.3 14.7 22.5 16.2 22.5 16.2 20.9 16.6 19.9 17.9 19.9 17.9 18.2 20.8 15.3 22.3 12 22.3S5.8 20.8 4.1 17.9C4.1 17.9 3.1 16.6 1.5 16.2 1.5 16.2 2.7 14.7 2.7 13.1 2.7 8.2 6.4 4.3 12 4.3Z"/>`,
    eyeY: 12.3,
    mouthY: 18.9,
    top: [12, 4.3],
    left: 2.7,
    right: 21.3,
    cheekY: 16.4,
    cheekDx: 6.9,
    light: [8, 7.2],
    front: (t, clip) =>
      (t === "s"
        ? ""
        : `<path d="M5.4 7.9 5.2 3.6 8.7 6.1Z" fill="var(--a)"/><path d="M18.6 7.9 18.8 3.6 15.3 6.1Z" fill="var(--a)"/>`) +
      `<path d="M12 14C14.6 14 16 15.5 18.8 15.8 17.8 20 15 22.3 12 22.3S6.2 20 5.2 15.8C8 15.5 9.4 14 12 14Z" fill="var(--bl)" clip-path="url(#${clip})"/>`,
    over: (t) =>
      `<ellipse cx="12" cy="16.7" rx="${t === "s" ? 1.15 : 0.95}" ry="${t === "s" ? 0.85 : 0.68}" fill="${INK}"/>`,
  },
  bird: {
    shapes: () => `<circle cx="12" cy="13" r="10"/>`,
    eyeY: 11.9,
    eyeScale: 1.1,
    mouthY: 18,
    top: [12, 3],
    left: 2,
    right: 22,
    cheekY: 15.8,
    cheekDx: 7.6,
    light: [7.4, 6.6],
    back: (t) =>
      `<g fill="var(--a)"><path d="M12 3.6C11.1 1.7 11.5 0 12.9-0.4 12.6 1 13 2.2 13.5 3.4Z"/>` +
      (t === "s"
        ? ""
        : `<path d="M11 3.8C9.5 2.6 8.9 1.1 9.5 0 10.1 1.2 11.1 2.2 12.2 3.1Z"/><path d="M13.1 3.6C14.1 2.1 15.6 1.5 16.9 1.9 15.7 2.5 14.9 3.3 14.3 4.2Z"/>`) +
      `</g>`,
    front: (t, clip) =>
      t === "s"
        ? ""
        : `<ellipse cx="12" cy="20.4" rx="6.6" ry="3.8" fill="var(--bl)" clip-path="url(#${clip})"/>`,
    over: () =>
      `<path d="M10.2 15.3 12 13.9 13.8 15.3Z" fill="var(--a)"/><path d="M10.2 15.3H13.8L12 17.3Z" fill="var(--as)"/>`,
    mouth: "none",
  },
  cloud: {
    shapes: () =>
      `<circle cx="7.4" cy="12.6" r="5.4"/><circle cx="12.6" cy="9.4" r="6.6"/><circle cx="17.8" cy="12.4" r="4.9"/><rect x="2" y="11.8" width="20.2" height="9.8" rx="4.9"/>`,
    eyeY: 13.4,
    mouthY: 18.4,
    top: [12.6, 2.8],
    left: 2,
    right: 22.2,
    cheekY: 16.8,
    cheekDx: 6.9,
    light: [9.6, 5.4],
  },
  bean: {
    shapes: () =>
      `<path d="M7.2 3.2C10.6 1.8 12.6 4.4 15.6 3.7 19.6 2.8 22.5 6.9 22.2 12.6 21.9 18.6 17.8 22.4 12 22.4 5.6 22.4 1.8 18.4 1.9 12.2 2 7.4 3.9 4.6 7.2 3.2Z"/>`,
    eyeY: 12.9,
    mouthY: 18.4,
    top: [12, 3.4],
    left: 1.9,
    right: 22.2,
    cheekY: 16.6,
    cheekDx: 7,
    light: [6.6, 6.4],
  },
};
