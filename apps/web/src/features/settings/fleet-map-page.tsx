import { useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { useElementSize } from "@/lib/element-size.ts";
import { cn } from "@/lib/cn.ts";
import { fleetMapLayout } from "./data/fleet-map-layout.ts";
import { useFleetMap } from "./data/use-fleet-map.ts";
import { useAccountOpenings } from "./fleet-map-openings.ts";
import { MapList, MapPanel } from "./fleet-map-panel.tsx";
import { FleetMapSvg } from "./fleet-map-svg.tsx";
import { FleetTabs } from "./fleet-tabs.tsx";
import { SettingsBody } from "./settings-body.tsx";

/** The map's smallest words are 12px: drawn smaller than this scale they'd fall under 11px. */
export const minScale = 11 / 12;
/** The panel sits beside the map from this column width, when the map still fits beside it. */
const besideFrom = 980;
const panelWidth = 260;
const gap = 24;

function Toggle(props: { label: string; checked: boolean; onChange(next: boolean): void }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
      <Checkbox checked={props.checked} onCheckedChange={(next) => props.onChange(next === true)} />
      {props.label}
    </label>
  );
}

/**
 * Settings › Fleet › Map: the fleet as a network diagram. ace's relay is a cloud, the local
 * network and the tailnet are zones, every machine and device is a node wired to this computer
 * the way it reaches it, and a broken wire says why. Selecting a node says more and offers its
 * fix. Too narrow to draw at a readable size, the same nodes are a list.
 */
export function FleetMapPage() {
  const openings = useAccountOpenings();
  const data = useFleetMap(openings.openings);
  const { map, ownId } = data;
  const layout = fleetMapLayout(map, ownId);
  const [picked, setPicked] = useState<string>();
  const [agentLinks, setAgentLinks] = useState(false);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(body);
  const fits = (room: number) => room >= layout.width * minScale;
  const beside = width >= besideFrom && fits(width - panelWidth - gap);
  const room = beside ? width - panelWidth - gap : width;
  const drawn = fits(room);
  // The first node that needs the person, else this computer, until one is picked.
  const selectedId =
    (picked && map.nodes.some((node) => node.id === picked) ? picked : undefined) ??
    map.nodes.find((node) => node.problem)?.id ??
    ownId;
  const selected = map.nodes.find((node) => node.id === selectedId);
  return (
    <SettingsBody page="Fleet" tabs={<FleetTabs />} wide>
      <div
        ref={body}
        className={cn("grid gap-6", beside ? "grid-cols-[minmax(0,1fr)_260px]" : "grid-cols-1")}
      >
        <div className="min-w-0">
          <div className="mb-1.5 flex flex-wrap items-center gap-3">
            <p className="min-w-45 flex-1 text-ui text-muted-foreground">{map.summary}</p>
            <Toggle label="Agent links" checked={agentLinks} onChange={setAgentLinks} />
            <Toggle label="Problems only" checked={problemsOnly} onChange={setProblemsOnly} />
          </div>
          {drawn ? (
            <FleetMapSvg
              map={map}
              layout={layout}
              ownId={ownId}
              selected={selectedId}
              agentLinks={agentLinks}
              problemsOnly={problemsOnly}
              width={Math.min(room, layout.width)}
              onSelect={setPicked}
            />
          ) : (
            <MapList
              map={map}
              ownId={ownId}
              selected={selectedId}
              problemsOnly={problemsOnly}
              onSelect={setPicked}
            />
          )}
        </div>
        {selected && (
          <div className={cn(!beside && "border-t border-border pt-3")}>
            <MapPanel node={selected} data={data} openings={openings} />
          </div>
        )}
      </div>
    </SettingsBody>
  );
}
