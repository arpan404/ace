import type { RemoteNetworks } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  fleetMapFacts,
  type FleetMap,
  type FleetMapInput,
  type MapMachineInput,
  type MapDeviceInput,
} from "@ace/ui-core/fleet-map";
import { fleetMapLayout, nodeBox, type Box, type MapLayout } from "./fleet-map-layout.ts";
import { crosses, distanceToSegment, overlaps, segmentsOf } from "./fleet-map-geometry.ts";

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

test.each(sizes)("with %i, %i and %i, no two wires share any stretch", (...size) => {
  const { layout } = laidOut(...size);
  const wires = layout.wires.map((wire) => ({
    node: wire.node,
    segments: segmentsOf(wire.points),
  }));
  for (const [index, wire] of wires.entries())
    for (const other of wires.slice(index + 1))
      for (const a of wire.segments)
        for (const b of other.segments)
          expect(overlaps(a, b), `${wire.node} and ${other.node}`).toBe(false);
});

test.each(sizes)(
  "with %i, %i and %i, every cross sits on its own wire, clear of every other",
  (...size) => {
    const { layout } = laidOut(...size);
    for (const wire of layout.wires.filter((entry) => entry.kind === "broken")) {
      const own = segmentsOf(wire.points);
      expect(own.some(([p, q]) => distanceToSegment(wire.mark, p, q) < 0.5)).toBe(true);
      // Not at a bend of its own, where a junction would read.
      for (const point of wire.points)
        expect(Math.hypot(point.x - wire.mark.x, point.y - wire.mark.y)).toBeGreaterThanOrEqual(10);
      for (const other of layout.wires.filter((entry) => entry.node !== wire.node))
        for (const [p, q] of segmentsOf(other.points))
          expect(
            distanceToSegment(wire.mark, p, q),
            `${wire.node} near ${other.node}`,
          ).toBeGreaterThanOrEqual(9);
    }
  },
);

test.each(sizes)(
  "with %i, %i and %i, whatever is reached over a network sits inside its zone",
  (...size) => {
    const { map, layout } = laidOut(...size);
    const zoneOf = { Tailscale: "tailnet", "local network": "lan" } as const;
    for (const node of map.nodes) {
      const wire = node.wire;
      if (wire?.kind !== "direct" || wire.from !== "mac") continue;
      const ways = wire.label
        .split(" or ")
        .flatMap((way) => (way === "Tailscale" || way === "local network" ? [zoneOf[way]] : []));
      const placed = layout.nodes.find((entry) => entry.id === node.id);
      if (!placed) throw new Error("not placed");
      const box = nodeBox(placed);
      for (const id of ways) {
        const zone = layout.zones.find((entry) => entry.id === id);
        expect(zone, `${node.name} in ${id}`).toBeDefined();
        if (!zone) continue;
        expect(
          box.x >= zone.box.x &&
            box.y >= zone.box.y &&
            box.x + box.width <= zone.box.x + zone.box.width &&
            box.y + box.height <= zone.box.y + zone.box.height,
          `${node.name} inside ${id}`,
        ).toBe(true);
      }
    }
  },
);

test("devices on this computer's network get short straight wires", () => {
  const input = fleet(1, 0, 2);
  const map = fleetMapFacts({
    ...input,
    machines: [
      {
        ...input.machines[0],
        id: "build",
        name: "Build server",
        status: "online",
        failed: false,
        via: { kind: "direct", url: "ws://100.64.0.7:4242" },
        working: 0,
      },
    ],
    devices: input.devices.map((device) =>
      Object.assign({}, device, { on: ["mac"], expiresAt: null }),
    ),
  });
  const layout = fleetMapLayout(map, "mac");
  const own = layout.nodes.find((node) => node.id === "mac");
  for (const wire of layout.wires.filter((entry) => entry.from === "mac")) {
    expect(wire.points, wire.node).toHaveLength(2);
    const [p, q] = wire.points;
    if (p && q && own && wire.node.startsWith("device:"))
      expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeLessThan(260);
  }
});

test.each(sizes)(
  "with the local network off and %i, %i and %i, wires stay apart and devices sit in the tailnet",
  (...size) => {
    const input = fleet(...size);
    const map = fleetMapFacts({ ...input, networks: { ...networks, lan: off } });
    const layout = fleetMapLayout(map, "mac");
    const all = layout.wires.map((wire) => segmentsOf(wire.points));
    for (const [index, wire] of all.entries())
      for (const other of all.slice(index + 1))
        for (const a of wire) for (const b of other) expect(overlaps(a, b)).toBe(false);
    const tailnet = layout.zones.find((zone) => zone.id === "tailnet");
    for (const node of map.nodes.filter((entry) => entry.wire?.label === "Tailscale")) {
      const placed = layout.nodes.find((entry) => entry.id === node.id);
      if (!placed || !tailnet) throw new Error("missing");
      const box = nodeBox(placed);
      expect(box.x >= tailnet.box.x && box.x + box.width <= tailnet.box.x + tailnet.box.width).toBe(
        true,
      );
      expect(
        box.y >= tailnet.box.y && box.y + box.height <= tailnet.box.y + tailnet.box.height,
      ).toBe(true);
    }
  },
);
