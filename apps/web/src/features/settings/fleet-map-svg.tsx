import { useId, type KeyboardEvent } from "react";
import type { MapLayout, PlacedWire, Point } from "./data/fleet-map-layout.ts";
import type { FleetMap, MapNode } from "@ace/ui-core/fleet-map";
import { DeviceArt, RelayCloud, tileHalf, toneColor } from "./fleet-map-art.tsx";
import { part } from "@/lib/suit-part.ts";

/*
 * The Fleet map as SVG, from its facts and layout, on a dotted canvas: the networks as soft
 * regions named inside, ace's relay as a region of its own, the wires as soft curves in their
 * route's style, agent links when asked for, and every node as a tile with its state dot, name and
 * status. A route is named once, by its region; why a node is broken is said once, under it. A
 * node is a button: click, Enter or Space selects it.
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

/**
 * A path through `points` with its corners rounded. A wire of one straight run is drawn as an S
 * curve that leaves and arrives along the map's flow, top to bottom.
 */
function pathOf(points: readonly Point[], radius = 10): string {
  const [first, ...rest] = points;
  if (!first) return "";
  const [last] = rest;
  if (rest.length === 1 && last && Math.abs(last.y - first.y) > 1) {
    const middle = (first.y + last.y) / 2;
    return `M${first.x} ${first.y} C${first.x} ${middle} ${last.x} ${middle} ${last.x} ${last.y}`;
  }
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

/** Words drawn over lines: a halo in the surface's colour keeps them readable. */
const halo = (surface: string) =>
  ({
    paintOrder: "stroke",
    stroke: surface,
    strokeWidth: 5,
    strokeLinejoin: "round",
  }) as const;

/** How far a wire's bends round off: wide enough to read as a curve. */
const bend = 28;

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
        d={pathOf(wire.points, bend)}
        fill="none"
        stroke={wireStroke[wire.kind]}
        strokeOpacity={issue(wire.kind) ? 1 : 0.6}
        strokeWidth={1.5}
        strokeDasharray={dash}
        strokeLinejoin="round"
      />
    </g>
  );
}

/** A node's status in its state's ink: working, a problem, else secondary. */
const statusInk = (node: MapNode) =>
  node.working
    ? "var(--status-working)"
    : node.tone === "bad" || node.tone === "warn"
      ? toneColor[node.tone]
      : "var(--muted-foreground)";

const clip = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

function Node(props: {
  node: MapNode;
  at: Point;
  selected: boolean;
  faded: boolean;
  /** What it's drawn on: a network's region or the canvas. */
  surface: string;
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
      className="group cursor-pointer"
      transform={`translate(${at.x} ${at.y})`}
      opacity={props.faded ? fadedOpacity : undefined}
      onClick={pick}
      onKeyDown={keys}
    >
      <rect x={-60} y={-34} width={120} height={92} fill="transparent" />
      <rect
        x={-tileHalf - 4}
        y={-tileHalf - 4}
        width={(tileHalf + 4) * 2}
        height={(tileHalf + 4) * 2}
        rx={16}
        fill="none"
        strokeWidth={1.5}
        stroke={props.selected ? "var(--foreground)" : "transparent"}
        className="group-hover:stroke-border-strong group-focus-visible:stroke-ring"
      />
      <DeviceArt art={node.art} quiet={quiet} />
      <circle
        cx={tileHalf - 3}
        cy={-tileHalf + 3}
        r={5}
        fill={toneColor[node.tone]}
        stroke="var(--background)"
        strokeWidth={2.5}
      />
      <text
        {...halo(props.surface)}
        y={40}
        textAnchor="middle"
        fontSize={13}
        fontWeight={500}
        fill={quiet ? "var(--muted-foreground)" : "var(--foreground)"}
      >
        {clip(node.name, 18)}
      </text>
      <text
        {...halo(props.surface)}
        y={56}
        textAnchor="middle"
        fontSize={12}
        fill={statusInk(node)}
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
  const dots = `fleet-map-dots-${useId().replace(/:/g, "")}`;
  return (
    <svg
      role="group"
      aria-label="Network map of your fleet"
      {...part("chart", undefined, "fleet-map")}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={props.width}
      height={(props.width / layout.width) * layout.height}
      className="block"
    >
      <defs>
        <pattern id={dots} width={16} height={16} patternUnits="userSpaceOnUse">
          <circle cx={1} cy={1} r={1} fill="var(--border-strong)" />
        </pattern>
      </defs>
      <rect width={layout.width} height={layout.height} rx={12} fill={`url(#${dots})`} />
      {layout.zones.map((zone) => (
        <rect
          key={zone.id}
          x={zone.box.x}
          y={zone.box.y}
          width={zone.box.width}
          height={zone.box.height}
          rx={20}
          fill="var(--card)"
          stroke="var(--border)"
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
              {...halo("var(--card)")}
              x={zone.label.anchor === "start" ? zone.box.x + 16 : zone.box.x + zone.box.width - 16}
              y={zone.box.y + 22}
              textAnchor={zone.label.anchor}
              fontSize={12.5}
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
              surface={node.zones.length > 0 ? "var(--card)" : "var(--background)"}
              onSelect={props.onSelect}
            />
          )
        );
      })}
    </svg>
  );
}
