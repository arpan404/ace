import type { MapArt, MapTone } from "@ace/ui-core/fleet-map";

/*
 * The Fleet map's drawings: each kind of machine or device as a tile with a line glyph, and ace's
 * relay as a rounded region with its name and host. Grey ink only; colour belongs to the state
 * dot and the status words.
 */

/** A glyph on a 16-unit grid, drawn 20 wide inside the node's tile. */
const glyphs: Record<MapArt, string> = {
  laptop: "M3.5 3.5h9a1 1 0 0 1 1 1v6h-11v-6a1 1 0 0 1 1-1ZM1 12.5h14",
  desktop:
    "M3 2.5h10a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1ZM6 13.5h4M8 11v2.5",
  server:
    "M3.5 2.5h9a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1ZM3.5 9h9a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1ZM5 4.75h.01M5 11.25h.01",
  phone:
    "M6.3 1.5h3.4a1.8 1.8 0 0 1 1.8 1.8v9.4a1.8 1.8 0 0 1-1.8 1.8H6.3a1.8 1.8 0 0 1-1.8-1.8V3.3a1.8 1.8 0 0 1 1.8-1.8ZM7.2 12.4h1.6",
  tablet:
    "M4.5 1.5h7A1.5 1.5 0 0 1 13 3v10a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13V3a1.5 1.5 0 0 1 1.5-1.5ZM7.2 12.4h1.6",
  browser: "M3 2.5h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM2 5.5h12",
};

/** Half a node tile's side. */
export const tileHalf = 22;

/** A node's tile and glyph around (0, 0). `quiet` draws the glyph in the subtle ink (offline). */
export function DeviceArt(props: { art: MapArt; quiet: boolean }) {
  return (
    <g aria-hidden>
      <rect
        x={-tileHalf}
        y={-tileHalf}
        width={tileHalf * 2}
        height={tileHalf * 2}
        rx={12}
        fill="var(--card)"
        stroke="var(--border-strong)"
      />
      <path
        d={glyphs[props.art]}
        transform="translate(-10 -10) scale(1.25)"
        fill="none"
        stroke={props.quiet ? "var(--subtle-foreground)" : "var(--foreground)"}
        strokeWidth={1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  );
}

/** A state's colour: done, needs you, failed, else the subtle ink for what isn't known. */
export const toneColor: Record<MapTone, string> = {
  on: "var(--status-done)",
  warn: "var(--status-needs-you)",
  bad: "var(--status-failed)",
  unknown: "var(--subtle-foreground)",
};

/** ace's relay: a rounded region with its name and host, centred on (x, y). */
export function RelayCloud(props: { x: number; y: number; label: string; host: string }) {
  return (
    <g transform={`translate(${props.x} ${props.y})`}>
      <rect
        x={-80}
        y={-30}
        width={160}
        height={56}
        rx={18}
        fill="var(--card)"
        stroke="var(--border-strong)"
      />
      <text
        y={props.host ? -3 : 4}
        textAnchor="middle"
        fontSize={13.5}
        fontWeight={600}
        fill="var(--foreground)"
      >
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
