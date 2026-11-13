import type { BotFace, BotFaceValue } from "./model.ts";
import {
  INK,
  PAPER,
  RING,
  egg,
  eyeGeometry,
  faceTier,
  n,
  type BodyShape,
  type EyeGeometry,
  type FaceTier,
} from "./draw-shared.ts";

/*
 * Ears, markings and accessories. Ears are drawn for the round head and moved down to each
 * body's top; markings are clipped to the silhouette; accessories wear the pair's accent so they
 * read on any canvas.
 */

interface Ears {
  back(tier: FaceTier): string;
  inner(tier: FaceTier): string;
}

export const EARS: Record<Exclude<BotFaceValue<"ears">, "none">, Ears> = {
  cat: {
    back: () =>
      `<path d="M3.2 9.6 3.3 2.1C3.4 1.3 4.1 1.1 4.7 1.5L10.2 4.6ZM20.8 9.6 20.7 2.1C20.6 1.3 19.9 1.1 19.3 1.5L13.8 4.6Z" fill="var(--bs)" stroke="var(--bs)" stroke-width="1.2" stroke-linejoin="round"/>`,
    inner: (t) =>
      t === "s" ? "" : `<path d="M4.9 6.6 5 3.4 8 5Z M19.1 6.6 19 3.4 16 5Z" fill="var(--a)"/>`,
  },
  bear: {
    back: () =>
      `<circle cx="4.6" cy="4.8" r="3.4" fill="var(--bs)"/><circle cx="19.4" cy="4.8" r="3.4" fill="var(--bs)"/>`,
    inner: (t) =>
      t === "s"
        ? ""
        : `<circle cx="4.9" cy="5.1" r="1.6" fill="var(--a)"/><circle cx="19.1" cy="5.1" r="1.6" fill="var(--a)"/>`,
  },
  bunny: {
    back: () =>
      `<rect x="5.4" y="-3.2" width="4.2" height="9.6" rx="2.1" transform="rotate(-12 7.5 3)" fill="var(--bs)"/>` +
      `<rect x="14.4" y="-3.2" width="4.2" height="9.6" rx="2.1" transform="rotate(12 16.5 3)" fill="var(--bs)"/>`,
    inner: (t) =>
      t === "s"
        ? ""
        : `<rect x="6.7" y="-1.8" width="1.6" height="5.8" rx=".8" transform="rotate(-12 7.5 3)" fill="var(--a)"/>` +
          `<rect x="15.7" y="-1.8" width="1.6" height="5.8" rx=".8" transform="rotate(12 16.5 3)" fill="var(--a)"/>`,
  },
  tuft: {
    back: () =>
      `<path d="M11.4 2.4C10.2 0.4 11.6-1.4 13.8-1 12.4-0.4 12.2 0.8 13 2.2Z" fill="var(--bs)"/>`,
    inner: () => "",
  },
  nubs: {
    back: () =>
      `<path d="M6.2 4.2C5.6 2.4 6 0.8 7.2 0.4 8.2 1.4 8.6 2.6 8.4 3.6ZM17.8 4.2C18.4 2.4 18 0.8 16.8 0.4 15.8 1.4 15.4 2.6 15.6 3.6Z" fill="var(--a)" stroke="var(--a)" stroke-width=".8" stroke-linejoin="round"/>`,
    inner: () => "",
  },
};

type Marking = (tier: FaceTier, eyes: EyeGeometry, body: BodyShape) => string;

export const MARKINGS: Record<Exclude<BotFaceValue<"marking">, "none">, Marking> = {
  cap: () => `<path d="M0 0H24V7.6C18 8.6 6 8.6 0 7.6Z" fill="var(--a)"/>`,
  mask: (_t, e) => {
    const { dx, rx, ry } = e.shape;
    return `<rect x="${n(12 - dx - rx - 1.6)}" y="${n(e.y - ry * 0.62)}" width="${n((dx + rx + 1.6) * 2)}" height="${n(ry * 1.25)}" rx="${n(ry * 0.62)}" fill="var(--mask)"/>`;
  },
  muzzle: (_t, _e, b) =>
    `<ellipse cx="12" cy="${n(b.mouthY + 1.6)}" rx="7.4" ry="${n(22.6 - b.mouthY + 0.6)}" fill="var(--bl)"/>`,
  patch: (_t, e) =>
    `<ellipse cx="${n(12 - e.shape.dx)}" cy="${n(e.y)}" rx="${n(e.shape.rx + 2.1)}" ry="${n(e.shape.ry + 1.9)}" fill="var(--a)"/>`,
  stripes: (t) =>
    `<g fill="none" stroke="var(--as)" stroke-width="${t === "s" ? 1.4 : 1.1}" stroke-linecap="round"><path d="M12 1.6V4.6"/>` +
    (t === "s" ? "" : `<path d="M8.6 2.2 9.2 4.8M15.4 2.2 14.8 4.8"/>`) +
    `</g>`,
  spots: (t) =>
    t === "s"
      ? `<circle cx="18.6" cy="6.4" r="1.6" fill="var(--a)"/>`
      : `<g fill="var(--a)"><circle cx="18.4" cy="6.4" r="1.7"/><circle cx="20.6" cy="9.8" r=".9"/><circle cx="4.6" cy="17" r="1.1"/></g>`,
};

/** Markings that follow the body's top rather than the eyes or mouth. */
export const topMarkings: ReadonlySet<string> = new Set(["cap", "stripes", "spots"]);

/** Which layer an accessory part draws in: behind the body, on it, or over the eyes. */
export type AccessoryLayer = "back" | "front" | "over";

export function drawAccessory(
  face: BotFace,
  size: number,
  body: BodyShape,
  layer: AccessoryLayer,
  clip: string,
): string {
  const kind = face.accessory;
  if (kind === "none") return "";
  const t = faceTier(size);
  const [tx, ty] = body.top;
  if (kind === "headphones") {
    if (layer === "back")
      return `<path data-part="accessory" d="M${n(body.left + 0.6)} 11.4C${n(body.left + 0.6)} ${n(ty - 3)} ${n(body.right - 0.6)} ${n(ty - 3)} ${n(body.right - 0.6)} 11.4" fill="none" stroke="var(--as)" stroke-width="${t === "s" ? 1.7 : 1.35}" stroke-linecap="round"/>`;
    if (layer !== "front") return "";
    const cup = (x: number) =>
      `<rect x="${n(x - 2)}" y="9.6" width="4" height="7.2" rx="2" fill="var(--a)"/>` +
      (t === "l"
        ? `<rect x="${n(x - 1.1)}" y="10.6" width="1" height="3.4" rx=".5" fill="${PAPER}" opacity=".35"/>`
        : "");
    return `<g data-part="accessory">${cup(body.left + 0.4)}${cup(body.right - 0.4)}</g>`;
  }
  if (kind === "beanie") {
    if (layer !== "front") return "";
    const fold = ty + 5.6;
    return (
      `<g data-part="accessory"><circle cx="${n(tx)}" cy="${n(ty - 0.6)}" r="${t === "s" ? 1.9 : 1.7}" fill="var(--a)"/>` +
      `<g clip-path="url(#${clip})"><path d="M0 0H24V${n(fold)}H0Z" fill="var(--a)"/><path d="M0 ${n(fold - 1.8)}H24V${n(fold)}H0Z" fill="var(--as)"/>` +
      (t === "l"
        ? `<path d="M7 ${n(ty + 1.6)}V${n(fold - 2.2)}M10 ${n(ty + 0.8)}V${n(fold - 2.2)}M13 ${n(ty + 0.6)}V${n(fold - 2.2)}M16 ${n(ty + 1.2)}V${n(fold - 2.2)}" stroke="var(--as)" stroke-width=".5" opacity=".7"/>`
        : "") +
      `</g></g>`
    );
  }
  if (kind === "scarf") {
    if (layer !== "front") return "";
    return (
      `<g data-part="accessory"><g clip-path="url(#${clip})"><path d="M0 18.2C6 19.8 18 19.8 24 18.2V21.6C18 23.2 6 23.2 0 21.6Z" fill="var(--a)"/></g>` +
      `<path d="M8.9 20.1C9.6 21.4 10 22.8 10.3 24.4L8.4 24.6C8.3 23.1 8.1 21.8 7.8 20.6Z" fill="var(--as)"/>` +
      `<path d="M7.9 20C7.1 21.3 6.4 22.6 6 24.1L7.9 24.5C8.2 23 8.6 21.7 9.1 20.5Z" fill="var(--a)"/>` +
      `<ellipse cx="8.5" cy="19.9" rx="1.5" ry="1.25" fill="var(--a)"/>` +
      (t === "s"
        ? ""
        : `<path d="M7.4 19.5Q8.5 19 9.6 19.5" fill="none" stroke="var(--as)" stroke-width=".45"/>`) +
      `</g>`
    );
  }
  if (layer !== "over") return "";
  if (kind === "glasses") {
    const e = eyeGeometry(face.eyes, size, body);
    const ring = RING[t];
    const gx = e.shape.rx + ring + 0.75;
    const gy = e.shape.ry + ring + 0.55;
    const w = t === "s" ? 1.05 : 0.8;
    const [left, right] = e.xs;
    return (
      `<g data-part="accessory"><path d="M${n(left - gx)} ${n(e.y - 0.8)}H${n(body.left + 0.3)}M${n(right + gx)} ${n(e.y - 0.8)}H${n(body.right - 0.3)}" stroke="${INK}" stroke-width="${w}" stroke-linecap="round"/>` +
      e.xs
        .map(
          (x) =>
            `<path d="${egg(x, e.y, gx, gy)}" fill="${PAPER}" fill-opacity="${t === "l" ? 0.12 : 0}" stroke="${INK}" stroke-width="${w}"/>`,
        )
        .join("") +
      `</g>`
    );
  }
  if (kind === "bow") {
    const bx = tx + 5;
    const by = ty + 2.6;
    const wing = (s: 1 | -1) =>
      `<path d="M${n(bx)} ${n(by)}C${n(bx + s * 1.6)} ${n(by - 2.5)} ${n(bx + s * 4.3)} ${n(by - 2.3)} ${n(bx + s * 4)} ${n(by)}C${n(bx + s * 4.3)} ${n(by + 2.3)} ${n(bx + s * 1.6)} ${n(by + 2.5)} ${n(bx)} ${n(by)}Z" fill="var(--a)"/>`;
    return (
      `<g data-part="accessory" transform="rotate(16 ${n(bx)} ${n(by)})">${wing(-1)}${wing(1)}` +
      (t === "s"
        ? ""
        : `<path d="M${n(bx - 3.6)} ${n(by + 0.5)}C${n(bx - 2.6)} ${n(by + 1.6)} ${n(bx - 1.2)} ${n(by + 1.4)} ${n(bx)} ${n(by)}C${n(bx + 1.2)} ${n(by + 1.4)} ${n(bx + 2.6)} ${n(by + 1.6)} ${n(bx + 3.6)} ${n(by + 0.5)}" fill="none" stroke="var(--as)" stroke-width=".6"/>`) +
      `<circle cx="${n(bx)}" cy="${n(by)}" r="1.2" fill="var(--as)"/></g>`
    );
  }
  // The flower: five paper petals around an accent heart.
  const fx = tx + 5.4;
  const fy = ty + 1.6;
  const petal = (deg: number) =>
    `<ellipse cx="${n(fx)}" cy="${n(fy - 1.45)}" rx="1.15" ry="1.5" transform="rotate(${deg} ${n(fx)} ${n(fy)})"/>`;
  return `<g data-part="accessory"><g fill="${PAPER}">${[0, 72, 144, 216, 288].map(petal).join("")}</g><circle cx="${n(fx)}" cy="${n(fy)}" r="1.05" fill="var(--a)"/></g>`;
}
