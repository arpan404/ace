/**
 * Spade's mark: a round head in the current text colour with two egg-shaped eyes. Without a
 * look they rest glancing a little down; with one the pupils turn toward it, kept inside the
 * eyes. The eyes are always paper white with near-black outlines and pupils, whatever
 * the theme; only the head follows it. Small sizes (24px and under) get a thicker outline and
 * bigger pupils and drop the catchlight, so the face still reads. Decorative: the place around
 * it carries the name.
 */

import {
  spadeEye,
  spadeEyes,
  spadePupilAt,
  spadePupilForSize,
  spadeTiltDeg,
  type SpadeLook,
} from "./spade-look.ts";

const paper = "#f6f6f7";
const ink = "#141416";

const round = (value: number) => Number(value.toFixed(2));
const n = (value: number) => round(value).toString();

/** An egg: flatter on top, fuller below. */
function egg(x: number, y: number, rx: number, ry: number): string {
  return (
    `M${n(x)} ${n(y - ry)}C${n(x + rx * 0.78)} ${n(y - ry)} ${n(x + rx)} ${n(y - ry * 0.36)} ${n(x + rx)} ${n(y + ry * 0.12)}` +
    `C${n(x + rx)} ${n(y + ry * 0.66)} ${n(x + rx * 0.58)} ${n(y + ry)} ${n(x)} ${n(y + ry)}` +
    `C${n(x - rx * 0.58)} ${n(y + ry)} ${n(x - rx)} ${n(y + ry * 0.66)} ${n(x - rx)} ${n(y + ry * 0.12)}` +
    `C${n(x - rx)} ${n(y - ry * 0.36)} ${n(x - rx * 0.78)} ${n(y - ry)} ${n(x)} ${n(y - ry)}Z`
  );
}

export function SpadeMark(props: {
  size?: number;
  className?: string | undefined;
  /** Where the pupils look; without one they rest low and a hair left. */
  look?: SpadeLook | undefined;
}) {
  const size = props.size ?? 20;
  const small = size <= 24;
  const ring = small ? 1.15 : size <= 40 ? 0.85 : 0.62;
  const { pupil, pad } = spadePupilForSize(size);
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={props.className}
      data-mark="spade"
    >
      <circle cx="12" cy="12" r="10.6" fill="currentColor" />
      <g transform={`rotate(${spadeTiltDeg} 12 12)`}>
        {spadeEyes.map((centre, index) => {
          const at = spadePupilAt(centre, pupil, pad, props.look);
          return (
            <g key={centre.x}>
              <path
                d={egg(centre.x, centre.y, spadeEye.rx + ring, spadeEye.ry + ring)}
                fill={ink}
              />
              <path d={egg(centre.x, centre.y, spadeEye.rx, spadeEye.ry)} fill={paper} />
              <ellipse
                cx={round(at.x)}
                cy={round(at.y)}
                rx={pupil.rx}
                ry={pupil.ry}
                fill={ink}
                data-spade-pupil={index}
              />
              {!small && (
                <circle
                  cx={round(at.x + pupil.rx * 0.38)}
                  cy={round(at.y - pupil.ry * 0.42)}
                  r={round(pupil.rx * 0.3)}
                  fill={paper}
                  data-spade-glint={index}
                />
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
