/**
 * Spade's mark: a round head in the current text colour with two egg-shaped eyes. Without a
 * look they rest glancing a little down; with one the pupils turn toward it, kept inside the
 * eyes. The eyes are always paper white with near-black outlines and pupils, whatever
 * the theme; only the head follows it. Small sizes (24px and under) get a thicker outline and
 * bigger pupils and drop the catchlight, so the face still reads. Decorative: the place around
 * it carries the name.
 */

import {
  spadeEggPath as egg,
  spadeEye,
  spadeEyes,
  spadePupilAt,
  spadePupilForSize,
  spadeRingForSize,
  spadeTiltDeg,
  type SpadeLook,
} from "@ace/ui-core/spade";

const paper = "#f6f6f7";
const ink = "#141416";

const round = (value: number) => Number(value.toFixed(2));

export function SpadeMark(props: {
  size?: number;
  className?: string | undefined;
  /** Where the pupils look; without one they rest low and a hair left. */
  look?: SpadeLook | undefined;
}) {
  const size = props.size ?? 20;
  const small = size <= 24;
  const ring = spadeRingForSize(size);
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
