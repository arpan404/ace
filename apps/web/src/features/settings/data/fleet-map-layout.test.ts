import type { RemoteNetworks } from "@ace/protocol";
import { expect, test } from "vitest";
import { fleetMapFacts } from "./fleet-map-facts.ts";
import { fleetMapLayout, nodeBox, type Box, type MapLayout } from "./fleet-map-layout.ts";
import { crosses } from "./fleet-map-route.ts";
import type {
  FleetMap,
  FleetMapInput,
  MapMachineInput,
  MapDeviceInput,
} from "./fleet-map-types.ts";

const now = 10 * 86_400_000;
const on = (address: string) => ({ state: "on", address });
const off = { state: "off" };
const networks: RemoteNetworks = {
  lan: on("https://192.168.1.20:4243"),
  tailscale: on("https://100.64.0.1:4243"),
  relay: off,
  account: on("wss://relay.acehq.dev"),
};

const statuses = ["online", "offline", "machine_code", "connecting", "auth_failed"] as const;
const urls = [
  "ws://100.64.0.9:4242",
  "ws://192.168.1.50:4242",
  "wss://relay.example.com",
  "ws://example.org:4242",
];

/** A fleet of `machines`, `account` and `devices`, varied but the same every time. */
function fleet(machines: number, account: number, devices: number): FleetMapInput {
  const pool: MapMachineInput[] = Array.from({ length: machines }, (_, index) => ({
    id: `m${index}`,
    name: `Machine ${index}`,
    status: statuses[index % statuses.length] ?? "online",
    failed: index % 4 === 1,
    via:
      index % 5 === 3
        ? { kind: "relay", url: urls[2] ?? "" }
        : { kind: "direct", url: urls[index % urls.length] ?? "" },
    working: index % 3,
  }));
  const paired: MapDeviceInput[] = Array.from({ length: devices }, (_, index) => ({
    key: `Phone ${index}`,
    name: `Phone ${index}`,
    on: index % 3 === 2 && machines ? ["m0"] : ["mac"],
    lastSeenAt: now - index * 60_000,
    expiresAt: index % 7 === 6 ? now - 1 : null,
    self: false,
    readOnly: false,
  }));
  return {
    own: { id: "mac", name: "This Mac", online: true, working: 2 },
    enabled: true,
    networks,
    relayHost: "relay.acehq.dev",
    machines: pool,
    account: Array.from({ length: account }, (_, index) => ({
      hostId: `a${index}`,
      name: `Account ${index}`,
      platform: "linux",
      lastSeenAt: now - index * 86_400_000,
      opening: undefined,
    })),
    devices: paired,
    links: pool.slice(0, 3).map((entry) => ({ from: "mac", to: entry.id })),
    now,
  };
}

const sizes = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 1],
  [2, 2, 2],
  [5, 3, 4],
  [12, 6, 9],
  [30, 10, 20],
] as const;

const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

function laidOut(machines: number, account: number, devices: number) {
  const map: FleetMap = fleetMapFacts(fleet(machines, account, devices));
  return { map, layout: fleetMapLayout(map, "mac") };
}

const inside = (layout: MapLayout, box: Box) =>
  box.x >= 0 &&
  box.y >= 0 &&
  box.x + box.width <= layout.width &&
  box.y + box.height <= layout.height;

test.each(sizes)("%i machines, %i account machines and %i devices never overlap", (...size) => {
  const { map, layout } = laidOut(...size);
  expect(layout.nodes).toHaveLength(map.nodes.length);
  const boxes = layout.nodes.map(nodeBox);
  for (const [index, box] of boxes.entries()) {
    expect(inside(layout, box)).toBe(true);
    for (const other of boxes.slice(index + 1)) expect(overlap(box, other)).toBe(false);
  }
});

test.each(sizes)(
  "with %i, %i and %i, every node but this computer has exactly one wire, and broken ones say why",
  (...size) => {
    const { map, layout } = laidOut(...size);
    for (const node of map.nodes) {
      const wires = layout.wires.filter((wire) => wire.node === node.id);
      expect(wires).toHaveLength(node.id === "mac" ? (node.wire ? 1 : 0) : 1);
    }
    for (const wire of layout.wires.filter((entry) => entry.kind === "broken"))
      expect(wire.label.length).toBeGreaterThan(0);
  },
);

test.each(sizes)("with %i, %i and %i, each zone holds its members and no one else", (...size) => {
  const { map, layout } = laidOut(...size);
  for (const zone of layout.zones)
    for (const node of layout.nodes) {
      const member = map.nodes.find((entry) => entry.id === node.id)?.zones.includes(zone.id);
      const box = nodeBox(node);
      const within =
        box.x >= zone.box.x &&
        box.y >= zone.box.y &&
        box.x + box.width <= zone.box.x + zone.box.width &&
        box.y + box.height <= zone.box.y + zone.box.height;
      if (member) expect(within).toBe(true);
      else expect(overlap(box, zone.box)).toBe(false);
    }
});

test.each(sizes)("with %i, %i and %i, no wire runs through another node", (...size) => {
  const { layout } = laidOut(...size);
  for (const wire of layout.wires) {
    const others = layout.nodes.filter((node) => node.id !== wire.node && node.id !== wire.from);
    for (const [index, point] of wire.points.slice(1).entries()) {
      const previous = wire.points[index];
      if (!previous) continue;
      for (const node of others) expect(crosses(previous, point, nodeBox(node))).toBe(false);
    }
  }
});

test("the same fleet always makes the same picture", () => {
  expect(laidOut(5, 3, 4).layout).toEqual(laidOut(5, 3, 4).layout);
});

test("offline machines sit outside every zone, and this computer is in both of its networks", () => {
  const { map, layout } = laidOut(5, 0, 0);
  const own = layout.nodes.find((node) => node.id === "mac");
  if (!own) throw new Error("no own node");
  for (const zone of layout.zones) expect(overlap(nodeBox(own), zone.box)).toBe(true);
  const offline = map.nodes.filter((node) => node.tone === "bad");
  expect(offline.length).toBeGreaterThan(0);
  for (const node of offline) {
    const placed = layout.nodes.find((entry) => entry.id === node.id);
    if (!placed) throw new Error("not placed");
    for (const zone of layout.zones) expect(overlap(nodeBox(placed), zone.box)).toBe(false);
  }
});
