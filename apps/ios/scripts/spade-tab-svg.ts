import {
  spadeEggPath as egg,
  spadeEye,
  spadeEyes,
  spadePupilAt,
  spadePupilForSize,
  spadeRingForSize,
  spadeTiltDeg,
} from "@ace/ui-core/spade";

/**
 * Spade's tab glyph: the face the web rail draws (`spade-mark.tsx`), in one colour so the tab
 * bar can tint it as a template image. Every shape comes from ui-core's face geometry
 * (`spade-look.ts`), so the phone's tab and the desktop's mark can't drift.
 *
 * - `regular`, the tab not chosen: the head as an outline, each eye its dark rim, pupils resting
 *   low and a hair left.
 * - `fill`, the tab chosen: the head solid with the eyes cut out of it and the pupils left in.
 *
 * The catchlight is left out: in one colour it would be a hole in the pupil too small to see.
 */

/** The head's radius on the 24 box, as the mark draws it. */
const head = 10.6;
/** The set's regular stroke on the 24 box, the other tabs' outline. */
const stroke = 1.75;

const round = (value: number) => Number(value.toFixed(2)).toString();

function circle(r: number): string {
  const arc = `A${round(r)} ${round(r)} 0 1 0`;
  return `M${round(12 - r)} 12${arc} ${round(12 + r)} 12${arc} ${round(12 - r)} 12Z`;
}

function ellipse(x: number, y: number, rx: number, ry: number): string {
  const arc = `A${round(rx)} ${round(ry)} 0 1 0`;
  return `M${round(x - rx)} ${round(y)}${arc} ${round(x + rx)} ${round(y)}${arc} ${round(x - rx)} ${round(y)}Z`;
}

export function spadeTabSvg(weight: "regular" | "fill", size: number): string {
  const ring = spadeRingForSize(size);
  const { pupil, pad } = spadePupilForSize(size);
  const eyes = spadeEyes.map((centre) => egg(centre.x, centre.y, spadeEye.rx, spadeEye.ry));
  const rims = spadeEyes.map((centre) =>
    egg(centre.x, centre.y, spadeEye.rx + ring, spadeEye.ry + ring),
  );
  const pupils = spadeEyes.map((centre) => {
    const at = spadePupilAt(centre, pupil, pad);
    return ellipse(at.x, at.y, pupil.rx, pupil.ry);
  });
  // A circle about the box's centre turns into itself, so the head can sit in the tilted group.
  const face =
    weight === "fill"
      ? `<path fill="#000000" fill-rule="evenodd" d="${circle(head)}${eyes.join("")}"></path>`
      : `<path fill="none" stroke="#000000" stroke-width="${stroke}" d="${circle(head - stroke / 2)}"></path>` +
        rims
          .map(
            (rim, index) =>
              `<path fill="#000000" fill-rule="evenodd" d="${rim}${eyes[index]}"></path>`,
          )
          .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">` +
    `<g transform="rotate(${spadeTiltDeg} 12 12)">${face}<path fill="#000000" d="${pupils.join("")}"></path></g></svg>\n`
  );
}
