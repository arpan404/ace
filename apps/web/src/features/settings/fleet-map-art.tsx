import type { MapArt, MapTone } from "./data/fleet-map-types.ts";

/*
 * The Fleet map's drawings: each kind of machine or device as line artwork about 44 wide around
 * its centre, and ace's relay as a cloud. Grey ink only; colour belongs to the state dot.
 */

const line = { strokeWidth: 1.6, strokeLinejoin: "round", strokeLinecap: "round" } as const;

/** One kind's artwork, drawn around (0, 0). `quiet` draws it in the subtle ink (offline). */
export function DeviceArt(props: { art: MapArt; quiet: boolean }) {
  const stroke = props.quiet ? "var(--subtle-foreground)" : "var(--foreground)";
  const body = { ...line, stroke, fill: "var(--card)" };
  const screen = { ...line, stroke, fill: "var(--surface-2)" };
  switch (props.art) {
    case "laptop":
      return (
        <g aria-hidden>
          <rect {...screen} x={-18} y={-18} width={36} height={24} rx={2.5} />
          <path {...body} d="M-24 9 H24 L20 14 H-20 Z" />
        </g>
      );
    case "desktop":
      return (
        <g aria-hidden>
          <rect {...screen} x={-20} y={-20} width={40} height={28} rx={2.5} />
          <path {...body} d="M-6 8 L-8 15 H8 L6 8 M-12 15 H12" />
        </g>
      );
    case "server":
      return (
        <g aria-hidden>
          {[-19, -6, 7].map((y) => (
            <g key={y}>
              <rect {...body} x={-18} y={y} width={36} height={11} rx={2} />
              <path {...body} d={`M-12 ${y + 5.5} h2 M-6 ${y + 5.5} h2`} />
            </g>
          ))}
        </g>
      );
    case "phone":
      return (
        <g aria-hidden>
          <rect {...screen} x={-10} y={-19} width={20} height={36} rx={4} />
          <path {...body} d="M-3 12 h6" />
        </g>
      );
    case "tablet":
      return (
        <g aria-hidden>
          <rect {...screen} x={-16} y={-19} width={32} height={36} rx={4} />
          <path {...body} d="M-3 12 h6" />
        </g>
      );
    case "browser":
      return (
        <g aria-hidden>
          <rect {...screen} x={-20} y={-17} width={40} height={30} rx={3} />
          <path {...body} d="M-20 -9 H20 M-15 -13 h1 M-11 -13 h1" />
        </g>
      );
  }
}

/** A state's colour: done, needs you, failed, else the subtle ink for what isn't known. */
export const toneColor: Record<MapTone, string> = {
  on: "var(--status-done)",
  warn: "var(--status-needs-you)",
  bad: "var(--status-failed)",
  unknown: "var(--subtle-foreground)",
};

/** ace's relay: a cloud with its name and host, centred on (x, y). */
export function RelayCloud(props: { x: number; y: number; label: string; host: string }) {
  return (
    <g transform={`translate(${props.x} ${props.y})`}>
      <path
        d="M-58 22 C-80 22 -82 -6 -60 -8 C-60 -30 -30 -36 -18 -20 C-10 -40 26 -40 30 -16 C52 -22 70 -2 58 12 C72 18 64 30 48 26 Z"
        fill="var(--card)"
        stroke="var(--muted-foreground)"
        strokeWidth={1.5}
      />
      <text y={-2} textAnchor="middle" fontSize={14} fontWeight={600} fill="var(--foreground)">
        {props.label}
      </text>
      {props.host && (
        <text y={14} textAnchor="middle" fontSize={12} fill="var(--muted-foreground)">
          {props.host}
        </text>
      )}
    </g>
  );
}
