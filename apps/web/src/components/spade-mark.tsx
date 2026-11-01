/**
 * Spade's mark at rest: a round head in the current text colour with two egg-shaped eyes looking
 * a little down. The eyes are always paper white with near-black outlines and pupils, whatever
 * the theme; only the head follows it. Small sizes (24px and under) get a thicker outline and
 * bigger pupils and drop the catchlight, so the face still reads. Decorative: the place around
 * it carries the name.
 */

const paper = "#f6f6f7";
const ink = "#141416";
/** The eyes, a touch below the middle; the whole face tilts 4° for character. */
const eyes = [
  { x: 8.7, y: 11.9 },
  { x: 15.3, y: 11.9 },
] as const;
const eye = { rx: 2.3, ry: 3.55 };
/** Where the pupils rest: low and a hair to the left. */
const rest = { dx: -0.25, dy: 2 };
const tilt = -4;

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

/** The pupil's centre: the resting look, kept inside the eye. */
function pupilAt(centre: { x: number; y: number }, pupil: { rx: number; ry: number }, pad: number) {
  const ax = eye.rx - pupil.rx - pad;
  const ay = eye.ry - pupil.ry - pad;
  let { dx, dy } = rest;
  const reach = (dx * dx) / (ax * ax) + (dy * dy) / (ay * ay);
  if (reach > 1) {
    const scale = 1 / Math.sqrt(reach);
    dx *= scale;
    dy *= scale;
  }
  return { x: centre.x + dx, y: centre.y + dy };
}

export function SpadeMark(props: { size?: number; className?: string | undefined }) {
  const size = props.size ?? 20;
  const small = size <= 24;
  const ring = small ? 1.15 : size <= 40 ? 0.85 : 0.62;
  const pupil = small ? { rx: 1.25, ry: 1.8 } : { rx: 1.1, ry: 1.6 };
  const pad = small ? 0.02 : 0.22;
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
      <g transform={`rotate(${tilt} 12 12)`}>
        {eyes.map((centre) => {
          const at = pupilAt(centre, pupil, pad);
          return (
            <g key={centre.x}>
              <path d={egg(centre.x, centre.y, eye.rx + ring, eye.ry + ring)} fill={ink} />
              <path d={egg(centre.x, centre.y, eye.rx, eye.ry)} fill={paper} />
              <ellipse cx={round(at.x)} cy={round(at.y)} rx={pupil.rx} ry={pupil.ry} fill={ink} />
              {!small && (
                <circle
                  cx={round(at.x + pupil.rx * 0.38)}
                  cy={round(at.y - pupil.ry * 0.42)}
                  r={round(pupil.rx * 0.3)}
                  fill={paper}
                />
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
