import { hostOf, serving, subnetOf, tailnetOf } from "./networks.ts";
import { accountNode, deviceNode, machineNode, ownNode, plural, type NameOf } from "./map-nodes.ts";
import {
  relayEnd,
  type FleetMap,
  type FleetMapInput,
  type MapNode,
  type MapZone,
  type ZoneId,
} from "./map-types.ts";

/** The Fleet map's facts from the fleet's: see `fleet-map-types.ts`. Pure. */

function zonesOf(nodes: readonly MapNode[], input: FleetMapInput): MapZone[] {
  const networks = input.networks;
  const zones: MapZone[] = [];
  const has = (zone: ZoneId) => nodes.some((node) => node.zones.includes(zone));
  if (has("lan"))
    zones.push({
      id: "lan",
      label: "Local network",
      sub: subnetOf(serving(networks?.lan) ? networks?.lan.address : undefined),
    });
  if (has("tailnet")) {
    const addresses = [
      serving(networks?.tailscale) ? networks?.tailscale.address : undefined,
      ...input.machines.map((machine) =>
        machine.via?.kind === "direct" ? machine.via.url : undefined,
      ),
    ];
    zones.push({
      id: "tailnet",
      label: "Tailnet",
      sub: addresses.map(tailnetOf).find((name) => name !== undefined),
    });
  }
  return zones;
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

/** The map's facts: every node with its one wire, the zones that are known, and the summary. */
export function fleetMapFacts(input: FleetMapInput): FleetMap {
  const own = ownNode(input);
  const names: NameOf = (id) =>
    id === input.own.id
      ? input.own.name
      : (input.machines.find((machine) => machine.id === id)?.name ?? "A machine");
  // An account machine that opened joins the pool: it's drawn once, as the pool's.
  const listed = new Set([input.own.id, ...input.machines.map((machine) => machine.id)]);
  const nodes: MapNode[] = [
    own,
    ...input.machines
      .filter((machine) => machine.id !== input.own.id)
      .toSorted(byName)
      .map((machine) => machineNode(machine)),
    ...input.account
      .filter((machine) => !listed.has(machine.hostId))
      .toSorted(byName)
      .map((machine) => accountNode(machine, input.now)),
    ...input.devices.toSorted(byName).map((device) => deviceNode(device, input, names)),
  ];
  // Wires name this computer by its id.
  for (const node of nodes)
    if (node.wire?.from === "own") node.wire = { ...node.wire, from: input.own.id };
  const ids = new Set(nodes.map((node) => node.id));
  const pairs = new Map<string, { a: string; b: string }>();
  for (const link of input.links) {
    if (link.from === link.to || !ids.has(link.from) || !ids.has(link.to)) continue;
    const [a, b] = [link.from, link.to].toSorted();
    if (a && b) pairs.set(`${a}\u0000${b}`, { a, b });
  }
  const relayed = nodes.some((node) => node.wire?.from === relayEnd);
  const host =
    hostOf(input.networks?.account.address) ??
    hostOf(input.networks?.relay.address) ??
    input.relayHost;
  const problems = nodes.filter((node) => node.problem).length;
  return {
    nodes,
    zones: zonesOf(nodes, input),
    relay: relayed ? { label: "ace cloud", host: host ?? "" } : undefined,
    agentLinks: [...pairs.values()],
    problems,
    summary: summaryLine(nodes.length, problems),
  };
}

/** "6 machines and devices. 3 connections need you." */
export function summaryLine(count: number, problems: number): string {
  const counts = count <= 1 ? "Just this computer." : `${count} machines and devices.`;
  if (problems === 0) return `${counts} Nothing needs you.`;
  return `${counts} ${plural(problems, "connection")} ${problems === 1 ? "needs" : "need"} you.`;
}
