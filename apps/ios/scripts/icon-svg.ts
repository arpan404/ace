import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Icon } from "@ace/icons";

/**
 * Turns an `@ace/icons` component into the SVG an asset catalog keeps as a vector template
 * image. The web draws a cut (the gap beside an "off" slash, the hole under a "new" plus) with a
 * `<mask>`, but iOS's SVG renderer paints a mask at the image's intrinsic size and scales the
 * bitmap, so an icon drawn larger goes soft. Each cut becomes an even-odd `<clipPath>` instead,
 * which stays vector at any size.
 */

const round = (n: number) => String(Math.round(n * 100) / 100);
const number = String.raw`(-?\d*\.?\d+)`;

/** A circle as a closed path. */
function circlePath(cx: number, cy: number, r: number): string {
  const ring = `A${round(r)} ${round(r)} 0 1 0`;
  return `M${round(cx - r)} ${round(cy)}${ring} ${round(cx + r)} ${round(cy)}${ring} ${round(cx - r)} ${round(cy)}Z`;
}

/** The area a straight round-capped stroke covers: a rectangle along it with a half circle at each end. */
function bandPath(d: string, width: number): string {
  const match = new RegExp(`^M\\s*${number}[ ,]+${number}[ ,L]+${number}[ ,]+${number}$`).exec(
    d.trim(),
  );
  if (!match) throw new Error(`A cut stroke must be one straight line, not "${d}".`);
  const [x1, y1, x2, y2] = match.slice(1).map(Number) as [number, number, number, number];
  const r = width / 2;
  const length = Math.hypot(x2 - x1, y2 - y1);
  const nx = (-(y2 - y1) / length) * r;
  const ny = ((x2 - x1) / length) * r;
  const cap = `A${round(r)} ${round(r)} 0 0 0`;
  return (
    `M${round(x1 + nx)} ${round(y1 + ny)}L${round(x2 + nx)} ${round(y2 + ny)}` +
    `${cap} ${round(x2 - nx)} ${round(y2 - ny)}L${round(x1 - nx)} ${round(y1 - ny)}` +
    `${cap} ${round(x1 + nx)} ${round(y1 + ny)}Z`
  );
}

/** The path of one cut, as the web's mask draws it in black. */
function cutPath(cut: string): string {
  const circle = new RegExp(
    `^<circle cx="${number}" cy="${number}" r="${number}" fill="black"></circle>$`,
  ).exec(cut);
  if (circle) {
    const [cx, cy, r] = circle.slice(1).map(Number) as [number, number, number];
    return circlePath(cx, cy, r);
  }
  const stroke = new RegExp(
    `^<path d="([^"]+)" stroke="black" stroke-width="${number}" stroke-linecap="round"></path>$`,
  ).exec(cut);
  if (stroke?.[1]) return bandPath(stroke[1], Number(stroke[2]));
  throw new Error(`An icon's mask holds a cut the iPhone can't clip: ${cut}`);
}

/**
 * An icon's markup with every mask made a clip: the whole 24 box with the cut taken out. A mask
 * with more than one cut is refused, since even-odd would put back where two cuts overlap.
 */
export function clippedSvg(markup: string): string {
  const clipped = markup
    .replace(
      /<mask id="([^"]+)"[^>]*><rect width="24" height="24" fill="white"><\/rect>(.*?)<\/mask>/g,
      (_, id: string, cuts: string) => {
        const parts = cuts.match(/<(circle|path)\b.*?<\/\1>/g) ?? [];
        if (parts.length !== 1 || parts[0] !== cuts)
          throw new Error(`An icon's mask must hold exactly one cut: ${cuts}`);
        return `<clipPath id="${id}"><path clip-rule="evenodd" d="M0 0H24V24H0Z${cutPath(cuts)}"></path></clipPath>`;
      },
    )
    .replaceAll('mask="url(#', 'clip-path="url(#');
  if (clipped.includes("<mask")) throw new Error("An icon's mask wasn't turned into a clip.");
  return clipped;
}

/** The drawing turned by `degrees` about the box's centre, for an icon the set draws only one way round. */
export function turnedSvg(markup: string, degrees: number): string {
  if (degrees === 0) return markup;
  const open = markup.indexOf(">") + 1;
  const close = markup.lastIndexOf("</svg>");
  return `${markup.slice(0, open)}<g transform="rotate(${degrees} 12 12)">${markup.slice(open, close)}</g></svg>`;
}

/**
 * The asset SVG for `icon` in `weight`, drawn in black (a template image takes only its shape)
 * at the 20pt a menu or swipe action draws an image it can't size itself.
 */
export function assetSvg(icon: Icon, weight: "regular" | "bold", turn = 0): string {
  const markup = renderToStaticMarkup(createElement(icon, { size: 20, weight, color: "#000000" }));
  return `${turnedSvg(clippedSvg(markup), turn)}\n`;
}
