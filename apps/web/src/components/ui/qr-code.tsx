import createQr from "qrcode-generator";
import { useMemo } from "react";
import { AceWings } from "@/components/ace-mark.tsx";
import { cn } from "@/lib/cn.ts";

const quiet = 4;
const ink = "#111";

/**
 * The QR's geometry: rounded modules, the three finder eyes drawn whole, and a clear square in
 * the middle for the ace mark. Highest error correction (H, 30%) keeps it readable with the
 * centre covered: the cleared square stays under a fifth of the code's area.
 */
function qrShape(value: string) {
  const qr = createQr(0, "H");
  qr.addData(value);
  qr.make();
  const n = qr.getModuleCount();
  // An odd-sized centre square, about a fifth of the side, with one module of margin cleared.
  let logo = Math.floor(n * 0.2);
  if (logo % 2 === 0) logo += 1;
  const start = (n - logo) / 2;
  const inLogo = (row: number, col: number) =>
    row >= start - 1 && row < start + logo + 1 && col >= start - 1 && col < start + logo + 1;
  const inEye = (row: number, col: number) =>
    (row < 7 && col < 7) || (row < 7 && col >= n - 7) || (row >= n - 7 && col < 7);
  let dots = "";
  for (let row = 0; row < n; row++)
    for (let col = 0; col < n; col++) {
      if (!qr.isDark(row, col) || inEye(row, col) || inLogo(row, col)) continue;
      // A softly rounded square per module, nearly touching its neighbours: round dots leave
      // gaps some scanners misread at large sizes.
      dots += roundedSquare(col + quiet + 0.04, row + quiet + 0.04, 0.92, 0.26);
    }
  const eyes = [
    [0, 0],
    [n - 7, 0],
    [0, n - 7],
  ].map(([col = 0, row = 0]) => ({ x: col + quiet, y: row + quiet }));
  return { size: n + quiet * 2, dots, eyes, logo: { at: start + quiet, size: logo } };
}

/**
 * A QR code branded with the ace mark: rounded eyes and modules, and the app icon in the
 * middle, dark on white with a quiet zone so phone cameras read it in either theme. `label` is
 * the accessible name; show the payload as text nearby too.
 */
function QrCode(props: { value: string; label: string; size?: number; className?: string }) {
  const shape = useMemo(() => qrShape(props.value), [props.value]);
  const size = props.size ?? 176;
  const { logo } = shape;
  const pad = logo.size * 0.08;
  return (
    <svg
      role="img"
      aria-label={props.label}
      width={size}
      height={size}
      viewBox={`0 0 ${shape.size} ${shape.size}`}
      className={cn("rounded-lg bg-white", props.className)}
    >
      <path d={shape.dots} fill={ink} />
      {shape.eyes.map((eye) => (
        <g key={`${eye.x}-${eye.y}`} fill={ink}>
          {/* The ring: an outer rounded square with the inner one cut out. */}
          <path
            fillRule="evenodd"
            d={`${roundedSquare(eye.x, eye.y, 7, 2)}${roundedSquare(eye.x + 1, eye.y + 1, 5, 1.4)}`}
          />
          <rect x={eye.x + 2} y={eye.y + 2} width={3} height={3} rx={0.9} />
        </g>
      ))}
      <rect
        x={logo.at + pad}
        y={logo.at + pad}
        width={logo.size - pad * 2}
        height={logo.size - pad * 2}
        rx={(logo.size - pad * 2) * 0.3}
        fill={ink}
      />
      {/* The mark is drawn on a 24-unit box (as in the app icon): scale it into the tile. */}
      <g
        fill="#fff"
        transform={`translate(${logo.at + logo.size * 0.2} ${logo.at + logo.size * 0.24}) scale(${(logo.size * 0.6) / 24})`}
      >
        <AceWings />
      </g>
    </svg>
  );
}

/** A square path with rounded corners, clockwise from the top-left. */
function roundedSquare(x: number, y: number, side: number, radius: number): string {
  const r = radius;
  const s = side;
  return `M${x + r} ${y}h${s - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${s - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(s - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(s - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`;
}

export { QrCode };
