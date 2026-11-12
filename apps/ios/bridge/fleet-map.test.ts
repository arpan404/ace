import { until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { combineFleetMap, FleetMapCombineRequest } from "./fleet-map.ts";
import { readFleetMapPart } from "./fleet-map-part.ts";

/*
 * The phone's Fleet map over the real SDK and in-process fake daemons: each machine answers its
 * own part, and the combined list says how every machine and device is reached, what's wrong
 * and the fix, with each machine's reach rows. The phone connects as the fixtures' iPhone.
 */

const clients: ClientCore[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((owner) => owner.close()));
});

const now = 1_800_000_000_000;

async function connect(daemon: FakeDaemon): Promise<ClientCore> {
  const owner = new ClientCore({
    deviceId: DeviceId.parse("device-iphone"),
    expectedHostId: HostId.parse(daemon.hostId),
    transport: () => fakeTransport(daemon),
    credential: async () => ({ token: "ios-test-token" }),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    id: () => crypto.randomUUID(),
    random: () => 0.5,
    now: () => Date.now(),
  });
  clients.push(owner);
  await owner.start();
  await until(() => (owner.state === "ready" ? owner : undefined));
  return owner;
}

function machine(host: string, settings: Record<string, boolean>): FakeDaemon {
  const daemon = new FakeDaemon({ clock: () => now, hostId: host, token: "ios-test-token" });
  daemon.services.settings.seed(settings);
  return daemon;
}

const part = async (daemon: FakeDaemon) =>
  readFleetMapPart(await connect(daemon), new AbortController().signal);

const ready = (id: string, url: string, read: Awaited<ReturnType<typeof part>>) => ({
  id,
  name: id,
  connection: "ready",
  target: { kind: "direct", url },
  working: 0,
  part: read,
});

test("the map lists each machine as the phone reaches it and each device with its problem and fix", async () => {
  const studio = machine("studio", {
    "remote.enabled": true,
    "remote.lan": true,
    "remote.tailscale": true,
  });
  const mini = machine("mini", {
    "remote.enabled": true,
    "remote.lan": false,
    "remote.tailscale": false,
    "remote.relay": false,
  });
  // A phone paired only with mini, where every network paired devices use is off.
  mini.access.completePairing("Pixel 9");
  const view = combineFleetMap(
    FleetMapCombineRequest.parse({
      type: "fleetMap.combine",
      machines: [
        { ...ready("studio", "wss://studio.tail1a2b.ts.net:4243", await part(studio)), working: 2 },
        ready("mini", "wss://192.168.1.30:4243", await part(mini)),
        {
          id: "box",
          name: "box",
          connection: "reconnecting",
          problem: "unreachable",
          target: { kind: "relay", url: "wss://relay.example.com/box" },
        },
      ],
    }),
    now,
  );
  const row = (name: string) => view.rows.find((entry) => entry.name === name);

  expect(row("studio")).toMatchObject({
    tone: "on",
    token: "done",
    state: "Connected",
    line: "2 agents working · Tailscale",
    problem: null,
    fixes: [],
  });
  expect(row("mini")?.line).toBe("Online · local network");
  expect(row("box")).toMatchObject({
    tone: "bad",
    line: "Couldn't reach it",
    problem: { what: "box isn't answering." },
    fixes: [
      {
        id: "reconnect",
        label: "Try again",
        primary: true,
        action: { kind: "retry", machine: "box" },
      },
      {
        id: "removeMachine",
        label: "Remove",
        primary: false,
        action: { kind: "open", machine: "box" },
      },
    ],
  });

  // The fixtures' iPhone is this phone, paired with both: one row, judged against studio.
  expect(view.rows.filter((entry) => entry.name === "iPhone 16 Pro")).toHaveLength(1);
  expect(row("iPhone 16 Pro")?.lines).toContainEqual({
    label: "Last seen",
    value: "Now, this device",
  });
  expect(row("iPhone 16 Pro")?.lines).toContainEqual({ label: "Opens", value: "studio and mini" });
  expect(row("Pixel 9")).toMatchObject({
    tone: "warn",
    problem: {
      what: "Pixel 9 was paired with a code, and the networks paired devices use are off on mini.",
    },
  });
  expect(row("Pixel 9")?.fixes.map((fix) => [fix.label, fix.action])).toEqual([
    ["Turn on local network", { kind: "setting", machine: "mini", key: "remote.lan", value: true }],
    [
      "Ask it to sign in",
      {
        kind: "hint",
        text: "Open app.acehq.dev on Pixel 9 and sign in with your ace account. It then reaches every machine from anywhere, with no code.",
      },
    ],
  ]);
  expect(view.problems).toBe(2);
  expect(view.summary).toBe("6 machines and devices. 2 connections need you.");

  // Turning Tailscale off on studio asks first, naming who reaches it now.
  const tailscale = view.reach
    .find((entry) => entry.id === "studio")
    ?.rows.find((entry) => entry.id === "tailscale");
  expect(tailscale?.action).toEqual({
    label: "Turn off",
    key: "remote.tailscale",
    value: false,
    confirm: {
      title: "Turn off Tailscale on studio?",
      body: "iPhone 16 Pro and iPad Air may disconnect until they can reach studio another way.",
      confirm: "Turn off",
    },
  });
  // A machine that wasn't reached has no reach rows to show.
  expect(view.reach.map((entry) => entry.id)).toEqual(["studio", "mini"]);
});

test("with remote access off on a machine, its reach is one row to turn it on and its devices say why", async () => {
  const studio = machine("studio", { "remote.enabled": false });
  const view = combineFleetMap(
    FleetMapCombineRequest.parse({
      type: "fleetMap.combine",
      machines: [ready("studio", "wss://192.168.1.20:4243", await part(studio))],
    }),
    now,
  );
  expect(view.reach[0]?.rows).toEqual([
    {
      id: "remote",
      title: "Remote access",
      tone: "off",
      token: "idle",
      words: "Off. Nothing outside studio can reach it.",
      action: { label: "Turn on", key: "remote.enabled", value: true, confirm: null },
    },
  ]);
  const ipad = view.rows.find((entry) => entry.name === "iPad Air");
  expect(ipad?.problem?.what).toBe("iPad Air can't reach studio: remote access is off.");
  expect(ipad?.fixes[0]?.action).toEqual({
    kind: "setting",
    machine: "studio",
    key: "remote.enabled",
    value: true,
  });
});

test("removing a device revokes it on every machine it's on, after asking", async () => {
  const studio = machine("studio", { "remote.enabled": true, "remote.lan": true });
  const mini = machine("mini", { "remote.enabled": true, "remote.lan": true });
  studio.access.completePairing("Old iPad");
  const first = studio.access.list().find((device) => device.name === "Old iPad");
  const read = await part(studio);
  // Its access ran out yesterday.
  const expired = structuredClone(read);
  const old = expired.devices?.find((device) => device.id === first?.id);
  if (old) old.expiresAt = now - 86_400_000;
  const view = combineFleetMap(
    FleetMapCombineRequest.parse({
      type: "fleetMap.combine",
      machines: [
        ready("studio", "wss://192.168.1.20:4243", expired),
        ready("mini", "wss://192.168.1.30:4243", await part(mini)),
      ],
    }),
    now,
  );
  const row = view.rows.find((entry) => entry.name === "Old iPad");
  expect(row?.problem?.what).toBe("Old iPad's access has ended.");
  expect(row?.fixes[0]).toMatchObject({
    label: "Remove",
    action: {
      kind: "revoke",
      devices: [{ machine: "studio", deviceId: first?.id }],
      confirm: { title: "Remove Old iPad?", confirm: "Remove" },
    },
  });
});

test("the phone's connection reads as the web's machine states", () => {
  const view = combineFleetMap(
    FleetMapCombineRequest.parse({
      type: "fleetMap.combine",
      machines: [
        { id: "a", name: "a", connection: "reconnecting", problem: "revoked" },
        { id: "b", name: "b", connection: "ready", askingCode: true },
        { id: "c", name: "c", connection: "offline", off: true },
        { id: "d", name: "d", connection: "connecting" },
      ],
    }),
    now,
  );
  expect(
    view.rows.map((entry) => [entry.name, entry.line, entry.fixes.map((fix) => fix.label)]),
  ).toEqual([
    ["a", "Refused this iPhone", ["Remove"]],
    ["b", "Needs its code", ["Enter code"]],
    ["c", "Off on this device", []],
    ["d", "Connecting", []],
  ]);
});
