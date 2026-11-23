import {
  capitalize,
  fleetMapLayout,
  fleetMapZones,
  relayEnd,
  type MapArt,
  type MapLayout,
  type MapMachineInput,
  type MapNode,
  type MapTone,
} from "@ace/ui-core/fleet-map";

export interface FleetPicture {
  width: number;
  height: number;
  nodes: (MapLayout["nodes"][number] & {
    mark: MapArt;
    label: string;
    status: string;
    token: string;
  })[];
  zones: (MapLayout["zones"][number] & { name: string })[];
  wires: Pick<MapLayout["wires"][number], "node" | "from" | "kind" | "relayed" | "points">[];
  cloud?: { x: number; y: number; label: string } | undefined;
}

export const toneTokens: Record<MapTone, string> = {
  on: "done",
  warn: "needs-you",
  bad: "failed",
  unknown: "idle",
};

export function fleetPicture(
  nodes: readonly MapNode[],
  phone: MapNode,
  inputs: MapMachineInput[],
  summary: string,
  problems: number,
): FleetPicture {
  const hasRelay = nodes.some((node) => node.wire?.from === relayEnd);
  const accountRelay = inputs.some((input) => input.via?.kind === "account");
  const relay = hasRelay ? { label: accountRelay ? "ace cloud" : "Relay", host: "" } : undefined;
  const phoneRoutes = nodes.filter(
    (node) => node.role === "machine" && node.wire?.from === relayEnd,
  );
  const all = nodes.map((node): MapNode => {
    if (node.id === phone.id) {
      return {
        ...phone,
        zones: [
          ...new Set(
            nodes.filter((entry) => entry.role === "machine").flatMap((entry) => entry.zones),
          ),
        ],
        wire: phoneRoutes.length
          ? {
              from: relayEnd,
              kind: phoneRoutes.some((entry) => entry.wire?.kind === "relay") ? "relay" : "unknown",
              relayed: true,
              label: "relay",
            }
          : undefined,
      };
    }
    return node.wire?.from === "own" ? { ...node, wire: { ...node.wire, from: phone.id } } : node;
  });
  const zones = fleetMapZones(all, { networks: undefined, machines: inputs });
  const layout = fleetMapLayout(
    { nodes: all, zones, relay, agentLinks: [], summary, problems },
    phone.id,
  );
  const byId = new Map(all.map((node) => [node.id, node]));
  return {
    width: layout.width,
    height: layout.height,
    nodes: layout.nodes.flatMap((placed) => {
      const node = byId.get(placed.id);
      return node
        ? [
            {
              ...placed,
              mark: node.art,
              label: node.name,
              status: capitalize(node.status),
              token: toneTokens[node.tone],
            },
          ]
        : [];
    }),
    zones: layout.zones.map((zone) => ({
      ...zone,
      name: zones.find((entry) => entry.id === zone.id)?.label ?? zone.id,
    })),
    wires: layout.wires.map(({ node, from, kind, relayed, points }) => ({
      node,
      from,
      kind,
      relayed,
      points,
    })),
    cloud: layout.cloud && relay ? { ...layout.cloud, label: relay.label } : undefined,
  };
}
