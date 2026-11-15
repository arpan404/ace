import type { RemoteNetworks } from "@ace/protocol";
import { expect, test } from "vitest";
import { fleetMapFacts } from "./map-facts.ts";
import type { FleetMapInput, MapMachineInput, MapNode } from "./map-types.ts";

const now = 10 * 86_400_000;
const off = { state: "off" } as const;
const networks = (on: Partial<Record<keyof RemoteNetworks, string>>): RemoteNetworks => ({
  lan: on.lan ? { state: "on", address: on.lan } : off,
  tailscale: on.tailscale ? { state: "on", address: on.tailscale } : off,
  relay: on.relay ? { state: "on", address: on.relay } : off,
  account: on.account ? { state: "on", address: on.account } : off,
});

const machine = (overrides: Partial<MapMachineInput> & { id: string }): MapMachineInput => ({
  name: overrides.id,
  status: "online",
  failed: false,
  via: { kind: "direct", url: "ws://100.64.0.7:4242" },
  working: undefined,
  ...overrides,
});

function input(overrides: Partial<FleetMapInput> = {}): FleetMapInput {
  return {
    own: { id: "mac", name: "This Mac", online: true, working: 3 },
    enabled: true,
    networks: networks({ tailscale: "https://100.64.0.1:4243", account: "wss://cloud.acehq.dev" }),
    relayHost: "cloud.acehq.dev",
    machines: [],
    account: [],
    devices: [],
    links: [],
    now,
    ...overrides,
  };
}

const node = (nodes: readonly MapNode[], id: string) => {
  const found = nodes.find((entry) => entry.id === id);
  if (!found) throw new Error(`No node ${id}`);
  return found;
};

test.each([
  {
    case: "online over Tailscale",
    machine: machine({ id: "build" }),
    tone: "on",
    wire: { from: "mac", kind: "direct", label: "Tailscale" },
    zones: ["tailnet"],
    fixes: undefined,
  },
  {
    case: "online on the local network",
    machine: machine({ id: "nas", via: { kind: "direct", url: "ws://192.168.1.40:4242" } }),
    tone: "on",
    wire: { from: "mac", kind: "direct", label: "local network" },
    zones: ["lan"],
    fixes: undefined,
  },
  {
    case: "asking for its machine code through the relay",
    machine: machine({
      id: "studio",
      status: "machine_code",
      via: { kind: "account", url: "wss://cloud.acehq.dev" },
    }),
    tone: "warn",
    wire: { from: "relay", kind: "needs", label: "needs code" },
    zones: [],
    fixes: ["enterCode"],
  },
  {
    case: "offline after it couldn't be reached",
    machine: machine({ id: "old", status: "offline", failed: true }),
    tone: "bad",
    wire: { from: "mac", kind: "broken", label: "couldn't reach it" },
    zones: [],
    fixes: ["reconnect", "removeMachine"],
  },
  {
    case: "refusing this window",
    machine: machine({ id: "old", status: "auth_failed" }),
    tone: "bad",
    wire: { from: "mac", kind: "broken", label: "refused" },
    zones: [],
    fixes: ["removeMachine"],
  },
  {
    case: "still connecting",
    machine: machine({ id: "new", status: "connecting" }),
    tone: "unknown",
    wire: { from: "mac", kind: "unknown", label: "connecting" },
    zones: [],
    fixes: undefined,
  },
])("a machine $case is drawn that way, with its fix", (row) => {
  const map = fleetMapFacts(input({ machines: [row.machine] }));
  const drawn = node(map.nodes, row.machine.id);
  expect(drawn.tone).toBe(row.tone);
  expect(drawn.wire).toMatchObject(row.wire);
  expect(drawn.zones).toEqual(row.zones);
  expect(drawn.problem?.fixes).toEqual(row.fixes);
});

test("agents working are counted only for machines that report them", () => {
  const map = fleetMapFacts(
    input({
      machines: [
        machine({ id: "build", working: 1 }),
        machine({ id: "quiet", working: 0 }),
        machine({ id: "unread", working: undefined }),
        machine({ id: "gone", status: "offline", working: 4 }),
      ],
    }),
  );
  expect(node(map.nodes, "mac").status).toBe("3 agents working");
  expect(node(map.nodes, "build").status).toBe("1 agent working");
  expect(node(map.nodes, "quiet").status).toBe("Online");
  // Unknown is never said as idle: no agents line at all.
  expect(node(map.nodes, "unread").lines.map((line) => line.label)).not.toContain("Agents");
  expect(node(map.nodes, "gone").status).toBe("Offline");
});

test.each([
  {
    case: "seen lately and not opened: neutral, with Open offered",
    machine: { lastSeenAt: now - 120_000, opening: undefined },
    tone: "unknown",
    kind: "relay",
    offer: "openAccount",
    fixes: undefined,
  },
  {
    case: "not seen for 3 days",
    machine: { lastSeenAt: now - 3 * 86_400_000, opening: undefined },
    tone: "bad",
    kind: "broken",
    label: "not seen 3 days",
    fixes: ["openAccount", "forgetMachine"],
  },
  {
    case: "asking for its code once opened",
    machine: { lastSeenAt: now, opening: { kind: "asking" } as const },
    tone: "warn",
    kind: "needs",
    fixes: ["enterCode"],
  },
  {
    case: "refused when opened",
    machine: { lastSeenAt: now, opening: { kind: "failed", message: "It said no." } as const },
    tone: "bad",
    kind: "broken",
    fixes: ["openAccount", "forgetMachine"],
  },
])("an account machine $case", (row) => {
  const map = fleetMapFacts(
    input({ account: [{ hostId: "studio", name: "Studio", platform: "darwin", ...row.machine }] }),
  );
  const drawn = node(map.nodes, "studio");
  expect(drawn.tone).toBe(row.tone);
  expect(drawn.wire).toMatchObject({ from: "relay", kind: row.kind, relayed: true });
  if (row.label) expect(drawn.wire?.label).toBe(row.label);
  expect(drawn.problem?.fixes).toEqual(row.fixes);
  expect(drawn.offer).toBe(row.offer);
});

const iPad = {
  key: "iPad Air",
  name: "iPad Air",
  on: ["mac"],
  lastSeenAt: now - 60_000,
  expiresAt: null,
  self: false,
  readOnly: true,
};

test.each([
  {
    case: "reaches it over Tailscale, inside the tailnet",
    over: {},
    tone: "on",
    wire: { from: "mac", kind: "direct", label: "Tailscale" },
    zones: ["tailnet"],
  },
  {
    case: "reaches it over either network, inside both",
    over: {
      networks: networks({ lan: "https://192.168.1.20", tailscale: "https://100.64.0.1" }),
    },
    tone: "on",
    wire: { from: "mac", kind: "direct", label: "Tailscale or local network" },
    zones: ["lan", "tailnet"],
  },
  {
    case: "has nothing it can use when only ace's account relay serves",
    over: { networks: networks({ account: "wss://cloud.acehq.dev" }) },
    tone: "warn",
    wire: { from: "mac", kind: "broken", label: "local network off" },
    fixes: ["turnOnLan", "askSignIn"],
  },
  {
    case: "goes through the person's relay when it's the only way",
    over: { networks: networks({ relay: "wss://relay.example.com" }) },
    tone: "on",
    wire: { from: "relay", kind: "relay", label: "relay" },
  },
  {
    case: "is cut off while remote access is off",
    over: { enabled: false },
    tone: "bad",
    wire: { kind: "broken", label: "remote access off" },
    fixes: ["turnOnRemote"],
  },
  {
    case: "is neutral while the networks haven't loaded",
    over: { enabled: undefined, networks: undefined },
    tone: "unknown",
    wire: { kind: "unknown" },
  },
])("a paired device $case", (row) => {
  const map = fleetMapFacts(input({ devices: [iPad], ...row.over }));
  const drawn = node(map.nodes, "device:iPad Air");
  expect(drawn.tone).toBe(row.tone);
  expect(drawn.wire).toMatchObject(row.wire);
  expect(drawn.problem?.fixes).toEqual(row.fixes);
  expect(drawn.zones).toEqual(row.zones ?? []);
});

test("a device whose access ended is broken with Remove as its fix", () => {
  const map = fleetMapFacts(input({ devices: [{ ...iPad, expiresAt: now - 1 }] }));
  const drawn = node(map.nodes, "device:iPad Air");
  expect(drawn.wire).toMatchObject({ kind: "broken", label: "access ended" });
  expect(drawn.problem?.fixes).toEqual(["removeDevice"]);
});

test("nothing loaded yet draws no problems: never broken before the facts arrive", () => {
  const map = fleetMapFacts(
    input({
      own: { id: "mac", name: "This Mac", online: false, working: undefined },
      enabled: undefined,
      networks: undefined,
      machines: [machine({ id: "build", status: "connecting" })],
      devices: [iPad],
    }),
  );
  expect(map.problems).toBe(0);
  expect(map.nodes.every((entry) => entry.tone === "unknown")).toBe(true);
  expect(map.zones).toEqual([]);
});

test("zones are drawn only for networks something is known to be on", () => {
  const tailOnly = fleetMapFacts(input());
  expect(tailOnly.zones.map((zone) => zone.id)).toEqual(["tailnet"]);
  const both = fleetMapFacts(
    input({
      networks: networks({
        lan: "https://192.168.1.20:4243",
        tailscale: "https://mac.tail1a2b.ts.net:4243",
      }),
    }),
  );
  expect(both.zones).toEqual([
    { id: "lan", label: "Local network", sub: "192.168.1.0" },
    { id: "tailnet", label: "Tailnet", sub: "tail1a2b.ts.net" },
  ]);
  expect(node(both.nodes, "mac").zones).toEqual(["lan", "tailnet"]);
  const none = fleetMapFacts(input({ networks: networks({ account: "wss://cloud.acehq.dev" }) }));
  expect(none.zones).toEqual([]);
});

test("the relay cloud shows only while something goes through it, named by its host", () => {
  expect(fleetMapFacts(input()).relay).toEqual({ label: "ace cloud", host: "cloud.acehq.dev" });
  expect(
    fleetMapFacts(input({ networks: networks({ tailscale: "https://100.64.0.1" }) })).relay,
  ).toBe(undefined);
});

test("agent links join machines on the map once per pair, either direction", () => {
  const map = fleetMapFacts(
    input({
      machines: [machine({ id: "build" })],
      links: [
        { from: "mac", to: "build" },
        { from: "build", to: "mac" },
        { from: "mac", to: "studio-not-on-map" },
      ],
    }),
  );
  expect(map.agentLinks).toEqual([{ a: "build", b: "mac" }]);
});

test("an account machine that joined the pool is drawn once", () => {
  const map = fleetMapFacts(
    input({
      machines: [machine({ id: "studio", name: "Studio" })],
      account: [
        {
          hostId: "studio",
          name: "Studio",
          platform: "darwin",
          lastSeenAt: now,
          opening: undefined,
        },
      ],
    }),
  );
  expect(map.nodes.filter((entry) => entry.name === "Studio")).toHaveLength(1);
});

test.each([
  { count: 1, problems: 0, says: "Just this computer. Nothing needs you." },
  { count: 6, problems: 1, says: "6 machines and devices. 1 connection needs you." },
  { count: 6, problems: 3, says: "6 machines and devices. 3 connections need you." },
])("the summary counts $count nodes and $problems problems", (row) => {
  const machines = Array.from({ length: row.count - 1 }, (_, index) =>
    machine({ id: `m${index}`, status: index < row.problems ? "offline" : "online" }),
  );
  expect(fleetMapFacts(input({ machines })).summary).toBe(row.says);
});
