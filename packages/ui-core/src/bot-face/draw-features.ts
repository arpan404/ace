import type { BotFace } from "./model.ts";
import {
  INK,
  LINE,
  PAPER,
  RING,
  egg,
  eyeGeometry,
  faceTier,
  n,
  type BodyShape,
  type FaceTier,
} from "./draw-shared.ts";

/*
 * Eyes, mouths, cheeks and the state extras. Eyes keep Spade's grammar in every theme: paper
 * with an ink outline and ink pupils, catchlights from m. Each part carries the classes the
 * motion sheet animates (`bf-ey` the eye, `bf-pu` the pupil, `bf-lid`, `bf-hp` the happy arc).
 */

export function drawEyes(face: BotFace, size: number, body: BodyShape, uid: string): string {
  const e = eyeGeometry(face.eyes, size, body);
  const { shape: s, tier: t, pupil, y } = e;
  const ring = RING[t];
  const lidFill = body.lid ?? "var(--b)";
  return e.xs
    .map((x, index) => {
      const clip = `${uid}e${index}`;
      const top = y - s.ry;
      const height = s.ry * 2;
      const half = s.rx * 0.95;
      const happy = `M${n(x - half)} ${n(y + 0.8)}Q${n(x)} ${n(y - s.ry)} ${n(x + half)} ${n(y + 0.8)}`;
      const glints =
        t === "l"
          ? `<circle cx="${n(x + pupil.rx * 0.36)}" cy="${n(y - pupil.ry * 0.4)}" r="${n(pupil.rx * 0.34)}" fill="${PAPER}"/>` +
            `<circle cx="${n(x - pupil.rx * 0.42)}" cy="${n(y + pupil.ry * 0.45)}" r="${n(pupil.rx * 0.14)}" fill="${PAPER}" opacity=".8"/>`
          : t === "m"
            ? `<circle cx="${n(x + pupil.rx * 0.34)}" cy="${n(y - pupil.ry * 0.38)}" r="${n(pupil.rx * 0.32)}" fill="${PAPER}"/>`
            : "";
      return (
        `<g data-part="eyes"><clipPath id="${clip}"><path d="${egg(x, y, s.rx, s.ry)}"/></clipPath>` +
        `<g class="bf-ey" style="--ax:${n(e.reach.x)}px;--ay:${n(e.reach.y)}px;--eh:${n(height)}px;--l0:${s.lid}">` +
        `<path d="${egg(x, y, s.rx + ring, s.ry + ring)}" fill="${INK}"/><path d="${egg(x, y, s.rx, s.ry)}" fill="${PAPER}"/>` +
        `<g clip-path="url(#${clip})"><g class="bf-pu"><ellipse cx="${n(x)}" cy="${n(y)}" rx="${n(pupil.rx)}" ry="${n(pupil.ry)}" fill="${INK}"/>${glints}</g>` +
        `<g class="bf-lid"><rect x="${n(x - s.rx - 1)}" y="${n(top - height - 0.2)}" width="${n(s.rx * 2 + 2)}" height="${n(height + 0.2)}" fill="${lidFill}"/>` +
        `<line x1="${n(x - s.rx - 1)}" x2="${n(x + s.rx + 1)}" y1="${n(top)}" y2="${n(top)}" stroke="${INK}" stroke-width="${n(ring * 0.95)}"/></g></g></g>` +
        `<g class="bf-hp"><path d="${happy}" fill="none" stroke="${INK}" stroke-width="${n(ring * 2 + 1.5)}" stroke-linecap="round"/>` +
        `<path d="${happy}" fill="none" stroke="${PAPER}" stroke-width="1.5" stroke-linecap="round"/></g></g>`
      );
    })
    .join("");
}

type MouthShape = (y: number, w: number, t: FaceTier) => string;

const MOUTHS: Record<"smile" | "open" | "cat" | "o" | "grin" | "frown", MouthShape> = {
  smile: (y, w) =>
    `<path d="M10.3 ${n(y)}Q12 ${n(y + 1.8)} 13.7 ${n(y)}" fill="none" stroke="${INK}" stroke-width="${n(w)}" stroke-linecap="round"/>`,
  open: (y, _w, t) =>
    `<path d="M9.9 ${n(y - 0.3)}Q12 ${n(y)} 14.1 ${n(y - 0.3)}Q13.9 ${n(y + 2.5)} 12 ${n(y + 2.5)}Q10.1 ${n(y + 2.5)} 9.9 ${n(y - 0.3)}Z" fill="${INK}"/>` +
    (t === "s"
      ? ""
      : `<path d="M10.9 ${n(y + 1.9)}Q12 ${n(y + 1)} 13.1 ${n(y + 1.9)}Q12.6 ${n(y + 2.4)} 12 ${n(y + 2.4)}Q11.4 ${n(y + 2.4)} 10.9 ${n(y + 1.9)}Z" fill="var(--tongue)"/>`),
  cat: (y, w) =>
    `<path d="M9.9 ${n(y)}Q10.95 ${n(y + 1.4)} 12 ${n(y)}Q13.05 ${n(y + 1.4)} 14.1 ${n(y)}" fill="none" stroke="${INK}" stroke-width="${n(w)}" stroke-linecap="round" stroke-linejoin="round"/>`,
  o: (y) => `<ellipse cx="12" cy="${n(y + 0.5)}" rx=".95" ry="1.15" fill="${INK}"/>`,
  grin: (y, _w, t) =>
    `<path d="M9.6 ${n(y - 0.2)}Q12 ${n(y + 0.3)} 14.4 ${n(y - 0.2)}Q14 ${n(y + 2.3)} 12 ${n(y + 2.3)}Q10 ${n(y + 2.3)} 9.6 ${n(y - 0.2)}Z" fill="${INK}"/>` +
    (t === "s"
      ? ""
      : `<rect x="11.35" y="${n(y)}" width="1.3" height=".95" rx=".25" fill="${PAPER}"/>`),
  frown: (y, w) =>
    `<path d="M10.4 ${n(y + 1.3)}Q12 ${n(y - 0.2)} 13.6 ${n(y + 1.3)}" fill="none" stroke="${INK}" stroke-width="${n(w)}" stroke-linecap="round"/>`,
};

/** The face's own mouth plus the ones states swap in: done smiles, blocked frowns, waiting says o. */
export function drawMouth(face: BotFace, size: number, body: BodyShape): string {
  if (body.mouth === "none" || face.mouth === "none") return "";
  const t = faceTier(size);
  const w = LINE[t];
  const y = body.mouthY;
  const own = MOUTHS[face.mouth](y, w, t);
  const done = (face.mouth === "open" || face.mouth === "grin" ? MOUTHS.open : MOUTHS.smile)(
    y,
    w,
    t,
  );
  return (
    `<g data-part="mouth"><g class="bf-m-own">${own}</g><g class="bf-m-done">${done}</g>` +
    `<g class="bf-m-fail">${MOUTHS.frown(y, w, t)}</g><g class="bf-m-wait">${MOUTHS.o(y, w, t)}</g></g>`
  );
}

/** Cheeks from m up: blush, or freckles (two dots at m, three a side at l). */
export function drawCheeks(face: BotFace, size: number, body: BodyShape): string {
  const t = faceTier(size);
  if (face.cheeks === "none" || t === "s") return "";
  const y = body.cheekY;
  const dx = body.cheekDx;
  if (face.cheeks === "blush")
    return `<g data-part="cheeks" fill="var(--blush)"><ellipse cx="${n(12 - dx)}" cy="${n(y)}" rx="1.9" ry="1.1"/><ellipse cx="${n(12 + dx)}" cy="${n(y)}" rx="1.9" ry="1.1"/></g>`;
  if (t === "m")
    return `<g data-part="cheeks" fill="var(--bs)"><circle cx="${n(12 - dx)}" cy="${n(y)}" r=".55"/><circle cx="${n(12 + dx)}" cy="${n(y)}" r=".55"/></g>`;
  const dots = (cx: number) =>
    `<circle cx="${n(cx - 0.9)}" cy="${n(y - 0.2)}" r=".42"/><circle cx="${n(cx + 0.5)}" cy="${n(y - 0.5)}" r=".38"/><circle cx="${n(cx)}" cy="${n(y + 0.7)}" r=".4"/>`;
  return `<g data-part="cheeks" fill="var(--bs)">${dots(12 - dx)}${dots(12 + dx)}</g>`;
}

/** A sweat drop when blocked and two sparkles when done, from m up; hidden until a state shows them. */
export function drawStateExtras(size: number, body: BodyShape): string {
  if (faceTier(size) === "s") return "";
  const sx = body.right - 2.2;
  const sy = body.eyeY - 6.2;
  const [tx, ty] = body.top;
  const spark = (x: number, y: number, k: number) =>
    `<path d="M${n(x)} ${n(y - 1.6 * k)}Q${n(x + 0.25 * k)} ${n(y - 0.25 * k)} ${n(x + 1.6 * k)} ${n(y)}Q${n(x + 0.25 * k)} ${n(y + 0.25 * k)} ${n(x)} ${n(y + 1.6 * k)}Q${n(x - 0.25 * k)} ${n(y + 0.25 * k)} ${n(x - 1.6 * k)} ${n(y)}Q${n(x - 0.25 * k)} ${n(y - 0.25 * k)} ${n(x)} ${n(y - 1.6 * k)}Z"/>`;
  return (
    `<g class="bf-sweat"><path d="M${n(sx)} ${n(sy)}C${n(sx + 1.2)} ${n(sy + 1.6)} ${n(sx + 1.4)} ${n(sy + 2.4)} ${n(sx + 1.4)} ${n(sy + 2.9)}A1.4 1.4 0 0 1 ${n(sx - 1.4)} ${n(sy + 2.9)}C${n(sx - 1.4)} ${n(sy + 2.4)} ${n(sx - 1.2)} ${n(sy + 1.6)} ${n(sx)} ${n(sy)}Z" fill="#cfe6ff" stroke="${INK}" stroke-width=".55"/></g>` +
    `<g class="bf-spark" fill="var(--a)"><g class="bf-sp1">${spark(tx + 8.6, ty + 1.2, 1)}</g><g class="bf-sp2">${spark(tx - 8.4, ty + 3.4, 0.7)}</g></g>`
  );
}
