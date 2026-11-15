import { Link } from "@tanstack/react-router";
import { primaryMachineId } from "@/lib/machines.ts";
import { cn } from "@/lib/cn.ts";
import { nodeStateWords, type FleetMap, type MapNode, type MapTone } from "@ace/ui-core/fleet-map";
import type { FleetMapData } from "./data/use-fleet-map.ts";
import { MapFixes } from "./fleet-map-fixes.tsx";
import type { AccountOpenings } from "./fleet-map-openings.ts";

/*
 * Beside or under the Fleet map: the selected node in words (how it's reached, when it was last
 * seen, and when something's wrong, what, why and the fix), and at narrow widths the map itself
 * as a list.
 */

const dot: Record<MapTone, string> = {
  on: "bg-status-done",
  warn: "bg-status-needs-you",
  bad: "bg-status-failed",
  unknown: "bg-subtle-foreground opacity-50",
};

function ToneDot(props: { tone: MapTone }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-[7px] shrink-0 rounded-full", dot[props.tone])}
    />
  );
}

export function MapPanel(props: { node: MapNode; data: FleetMapData; openings: AccountOpenings }) {
  const { node } = props;
  const page =
    node.role === "own" ? primaryMachineId : node.role === "machine" ? node.id : undefined;
  return (
    <section aria-label={`${node.name} details`} aria-live="polite">
      <h3 className="text-base font-semibold">{node.name}</h3>
      <span className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <ToneDot tone={node.tone} />
        {nodeStateWords(node)}
      </span>
      <dl className="mt-3 border-t border-border-soft">
        {node.lines.map((line) => (
          <div key={line.label} className="flex gap-2.5 border-b border-border-soft py-2 text-xs">
            <dt className="min-w-18 font-medium text-foreground">{line.label}</dt>
            <dd className="text-muted-foreground">{line.value}</dd>
          </div>
        ))}
      </dl>
      {node.problem ? (
        <div className="mt-3">
          <p className="text-ui leading-5 text-foreground">{node.problem.what}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{node.problem.why}</p>
          <MapFixes node={node} data={props.data} openings={props.openings} />
        </div>
      ) : (
        <div className="mt-3 text-xs text-muted-foreground">
          {node.offer ? (
            <MapFixes node={node} data={props.data} openings={props.openings} />
          ) : (
            "Nothing to do here."
          )}
        </div>
      )}
      {page && (
        <Link
          to="/settings/remote/$machine"
          params={{ machine: page }}
          className="mt-4 inline-block rounded-xs text-xs text-muted-foreground focus-ring hover:text-foreground"
        >
          Open {node.role === "own" ? "this computer's" : `${node.name}'s`} page
        </Link>
      )}
    </section>
  );
}

const wordsTone = (node: MapNode) =>
  node.wire?.kind === "broken"
    ? "text-status-failed"
    : node.wire?.kind === "needs"
      ? "text-status-needs-you"
      : "text-muted-foreground";

/** The map as rows, for a column too narrow to draw it at a readable size. */
export function MapList(props: {
  map: FleetMap;
  ownId: string;
  selected: string | undefined;
  problemsOnly: boolean;
  onSelect(id: string): void;
}) {
  const shown = props.map.nodes.filter(
    (node) => node.id !== props.ownId && (!props.problemsOnly || node.problem),
  );
  return (
    <ul aria-label="Machines and devices" className="border-t border-border-soft">
      {shown.map((node) => (
        <li key={node.id} className="border-b border-border-soft">
          <button
            type="button"
            aria-pressed={props.selected === node.id}
            onClick={() => props.onSelect(node.id)}
            className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-2.5 text-left focus-ring hover:bg-hover aria-pressed:bg-hover"
          >
            <ToneDot tone={node.tone} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui text-foreground">{node.name}</span>
              <span className={cn("mt-0.5 block text-xs", wordsTone(node))}>
                {node.wire?.label ?? node.status}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
