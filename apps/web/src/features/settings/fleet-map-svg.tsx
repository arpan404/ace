import type { KeyboardEvent } from "react";
import type { MapLayout, PlacedWire, Point } from "./data/fleet-map-layout.ts";
import type { FleetMap, MapNode } from "./data/fleet-map-types.ts";
import { DeviceArt, RelayCloud, toneColor } from "./fleet-map-art.tsx";

/*
 * The Fleet map as SVG, from its facts and layout: zones, the relay cloud, the wires with their
 * labels (a broken one crossed out), agent links when asked for, and every node as artwork with
 * its state dot, name and status. A node is a button: click, Enter or Space selects it.
 */

/** Faded, for what's fine while only problems are shown. */
export const fadedOpacity = 0.22;
const fadedWire = 0.12;

/** The point `length` along from `from` toward `to`. */
function toward(from: Point, to: Point, length: number): Point {
  const span = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  return {
    x: from.x + ((to.x - from.x) / span) * length,
    y: from.y + ((to.y - from.y) / span) * length,
  };
}

/** A path through `points` with its corners rounded. */
function pathOf(points: readonly Point[], radius = 10): string {
  const [first, ...rest] = points;
  if (!first) return "";
  let d = `M${first.x} ${first.y}`;
  for (const [index, point] of rest.entries()) {
    const next = rest[index + 1];
    const previous = points[index] ?? first;
    if (!next) {
      d += ` L${point.x} ${point.y}`;
      continue;
    }
    const into = Math.min(radius, Math.hypot(point.x - previous.x, point.y - previous.y) / 2);
    const out = Math.min(radius, Math.hypot(next.x - point.x, next.y - point.y) / 2);
    const a = toward(point, previous, into);
    const b = toward(point, next, out);
    d += ` L${a.x} ${a.y} Q${point.x} ${point.y} ${b.x} ${b.y}`;
  }
  return d;
}

const issue = (kind: PlacedWire["kind"]) => kind === "needs" || kind === "broken";

const wireStroke: Record<PlacedWire["kind"], string> = {
  direct: "var(--muted-foreground)",
  relay: "var(--muted-foreground)",
  unknown: "var(--subtle-foreground)",
  needs: "var(--status-needs-you)",
  broken: "var(--status-failed)",
};

/** Words drawn over lines: a halo in the background colour keeps them readable. */
const halo = {
  paintOrder: "stroke",
  stroke: "var(--background)",
  strokeWidth: 5,
  strokeLinejoin: "round",
} as const;

function Wire(props: { wire: PlacedWire; faded: boolean }) {
  const { wire } = props;
  const dash =
    wire.kind === "broken"
      ? "3 4"
      : wire.kind === "unknown"
        ? "2 4"
        : wire.relayed
          ? "6 5"
          : undefined;
  return (
    <g data-wire={wire.node} opacity={props.faded ? fadedWire : undefined}>
      <path
        d={pathOf(wire.points)}
        fill="none"
        stroke={wireStroke[wire.kind]}
        strokeWidth={1.8}
        strokeDasharray={dash}
        strokeLinejoin="round"
      />
      {!props.faded && wire.kind === "broken" && (
        <g transform={`translate(${wire.mark.x} ${wire.mark.y})`} aria-hidden>
          <circle r={9} fill="var(--background)" stroke="var(--status-failed)" strokeWidth={1.5} />
          <path
            d="M-4 -4 L4 4 M4 -4 L-4 4"
            stroke="var(--status-failed)"
            strokeWidth={2.4}
            strokeLinecap="round"
          />
        </g>
      )}
      {!props.faded && wire.label && (
        <text
          {...halo}
          x={wire.labelAt.x + (wire.kind === "broken" && wire.labelAt.anchor === "start" ? 6 : 0)}
          y={wire.labelAt.y - (wire.kind === "broken" && wire.labelAt.anchor === "middle" ? 4 : 0)}
          textAnchor={wire.labelAt.anchor}
          fontSize={12.5}
          fill={issue(wire.kind) ? wireStroke[wire.kind] : "var(--muted-foreground)"}
        >
          {wire.label}
        </text>
      )}
    </g>
  );
}

const clip = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

function Node(props: {
  node: MapNode;
  at: Point;
  selected: boolean;
  faded: boolean;
  onSelect(id: string): void;
}) {
  const { node, at } = props;
  const quiet = node.tone === "bad";
  const pick = () => props.onSelect(node.id);
  const keys = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    pick();
  };
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${node.name}, ${node.status}`}
      aria-pressed={props.selected}
      data-node={node.id}
      className="group cursor-pointer outline-none"
      transform={`translate(${at.x} ${at.y})`}
      opacity={props.faded ? fadedOpacity : undefined}
      onClick={pick}
      onKeyDown={keys}
    >
      <rect x={-60} y={-34} width={120} height={92} fill="transparent" />
      <rect
        x={-32}
        y={-30}
        width={64}
        height={54}
        rx={10}
        fill="none"
        strokeWidth={1.5}
        strokeDasharray="3 3"
        stroke={props.selected ? "var(--foreground)" : "transparent"}
        className="group-hover:stroke-foreground group-focus-visible:stroke-ring"
      />
      <DeviceArt art={node.art} quiet={quiet} />
      <circle
        cx={22}
        cy={-22}
        r={5.5}
        fill={toneColor[node.tone]}
        stroke="var(--background)"
        strokeWidth={2}
      />
      <text
        y={40}
        textAnchor="middle"
        fontSize={13.5}
        fontWeight={500}
        fill={quiet ? "var(--muted-foreground)" : "var(--foreground)"}
      >
        {clip(node.name, 18)}
      </text>
      <text
        y={56}
        textAnchor="middle"
        fontSize={12}
        fill={node.working ? "var(--status-working)" : "var(--muted-foreground)"}
      >
        {clip(node.status, 22)}
      </text>
    </g>
  );
}

export function FleetMapSvg(props: {
  map: FleetMap;
  layout: MapLayout;
  ownId: string;
  selected: string | undefined;
  agentLinks: boolean;
  problemsOnly: boolean;
  /** How wide it's drawn, in CSS pixels. */
  width: number;
  onSelect(id: string): void;
}) {
  const { map, layout } = props;
  const fadedNode = (node: MapNode) =>
    props.problemsOnly && !node.problem && node.id !== props.ownId;
  const at = new Map(layout.nodes.map((node) => [node.id, node]));
  return (
    <svg
      role="group"
      aria-label="Network map of your fleet"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={props.width}
      height={(props.width / layout.width) * layout.height}
      className="block"
    >
      {layout.zones.map((zone) => (
        <rect
          key={zone.id}
          x={zone.box.x}
          y={zone.box.y}
          width={zone.box.width}
          height={zone.box.height}
          rx={18}
          fill="none"
          stroke="var(--border-strong)"
          strokeWidth={1.5}
          strokeDasharray="6 5"
        />
      ))}
      {layout.cloud && map.relay && (
        <RelayCloud {...layout.cloud} label={map.relay.label} host={map.relay.host} />
      )}
      {layout.wires.map((wire) => (
        <Wire key={wire.node} wire={wire} faded={props.problemsOnly && !issue(wire.kind)} />
      ))}
      {props.agentLinks &&
        layout.agentLinks.map((link) => (
          <path
            key={`${link.a}:${link.b}`}
            data-agent-link={`${link.a} ${link.b}`}
            d={`M${link.points[0].x} ${link.points[0].y} Q${link.points[1].x} ${link.points[1].y} ${link.points[2].x} ${link.points[2].y}`}
            fill="none"
            stroke="var(--foreground)"
            strokeWidth={1.3}
            opacity={0.55}
          />
        ))}
      {layout.zones.map((zone) => {
        const facts = map.zones.find((entry) => entry.id === zone.id);
        return (
          facts && (
            <text
              key={zone.id}
              {...halo}
              x={zone.label.x}
              y={zone.label.y}
              textAnchor={zone.label.anchor}
              fontSize={13}
              fontWeight={500}
              fill="var(--muted-foreground)"
            >
              {facts.label}
              {facts.sub && (
                <tspan fontSize={12} fontWeight={400} fill="var(--subtle-foreground)">
                  {`  ${facts.sub}`}
                </tspan>
              )}
            </text>
          )
        );
      })}
      {map.nodes.map((node) => {
        const point = at.get(node.id);
        return (
          point && (
            <Node
              key={node.id}
              node={node}
              at={point}
              selected={props.selected === node.id}
              faded={fadedNode(node)}
              onSelect={props.onSelect}
            />
          )
        );
      })}
    </svg>
  );
}
