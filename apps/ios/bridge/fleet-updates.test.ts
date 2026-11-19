import { until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId, type MachineUpdate } from "@ace/protocol";
import { fleetRun, fleetUpdates, readMachineUpdate, startMachineUpdate } from "./fleet-updates.ts";

/*
 * Updating several machines from the phone over the real SDK and in-process fake daemons: each
 * machine reads and starts its own update, and shared code decides who to ask and what to say.
 */

const clients: ClientCore[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((owner) => owner.close()));
});

async function connect(daemon: FakeDaemon): Promise<ClientCore> {
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-fleet-test"),
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

/** A machine offered `available`, with `busy` agents at work. */
function machine(host: string, available: string | null, busy = 0): FakeDaemon {
  const daemon = new FakeDaemon({ clock: Date.now, hostId: host, token: "ios-test-token" });
  daemon.machineUpdate.seed({ state: available ? "available" : "none", available, busy });
  return daemon;
}

const signal = () => new AbortController().signal;
const now = 1_800_000_000_000;

async function fleet(daemons: Record<string, FakeDaemon>) {
  const entries = await Promise.all(
    Object.entries(daemons).map(async ([name, daemon]) => {
      const owner = await connect(daemon);
      const status = await readMachineUpdate(owner, signal());
      return {
        owner,
        fact: {
          id: daemon.hostId,
          name,
          online: true,
          access: "admin" as const,
          update: status.update,
        },
      };
    }),
  );
  return {
    owners: new Map<string, ClientCore>(entries.map((entry) => [entry.fact.id, entry.owner])),
    facts: entries.map((entry) => entry.fact),
  };
}

test("two machines with an update are offered Update all, and Update all now names their agents", async () => {
  const { facts } = await fleet({
    Studio: machine("studio", "0.0.19", 2),
    Laptop: machine("laptop", "0.0.19"),
  });
  const reply = fleetUpdates({ type: "fleet.updates", machines: facts, now });
  expect(reply.headline?.actions).toEqual(["all", "all-now"]);
  expect(reply.headline?.title).toContain("0.0.19");
  expect(reply.confirm.title).toBe("Update 2 machines now?");
  expect(reply.confirm.body).toContain("2 on Studio");
  expect(reply.sends).toEqual([]);
});

test("Update all asks every machine, and each one's answer moves the run on", async () => {
  const { owners, facts } = await fleet({
    Studio: machine("studio", "0.0.19"),
    Laptop: machine("laptop", "0.0.19"),
  });
  let run = fleetRun({ type: "fleet.run", op: "start", mode: "idle", machines: facts, now }).run;
  const due = fleetUpdates({ type: "fleet.updates", machines: facts, run, now });
  expect(due.sends.map((send) => send.id).toSorted()).toEqual(["laptop", "studio"]);
  for (const send of due.sends) {
    const owner = owners.get(send.id);
    if (!owner) throw new Error("No machine");
    const started = await startMachineUpdate(
      owner,
      {
        type: "machineUpdate.start",
        name: send.id,
        mode: send.mode,
        version: send.version,
        agents: send.agents,
      },
      signal(),
    );
    expect(started.ok).toBe(true);
    expect(started.update?.state).toBe("downloading");
    run = fleetRun({ type: "fleet.run", op: "sent", run, id: send.id, now }).run;
  }
  // Asked once each: nothing more is due.
  expect(fleetUpdates({ type: "fleet.updates", machines: facts, run, now }).sends).toEqual([]);
});

test("a refused start comes back in words, and the run says which machine failed", async () => {
  const { owners, facts } = await fleet({ Studio: machine("studio", "0.0.19") });
  const owner = owners.get("studio");
  if (!owner) throw new Error("No machine");
  // A newer release came out since the phone last read the machine.
  const started = await startMachineUpdate(
    owner,
    { type: "machineUpdate.start", name: "Studio", mode: "idle", version: "0.0.18", agents: 0 },
    signal(),
  );
  expect(started).toMatchObject({
    ok: false,
    words: "A newer release is out for Studio. Try again.",
  });
  const run = fleetRun({ type: "fleet.run", op: "start", mode: "idle", machines: facts, now }).run;
  const failed = fleetRun({
    type: "fleet.run",
    op: "failed",
    run,
    id: "studio",
    words: started.words ?? "",
  }).run;
  const line = fleetUpdates({ type: "fleet.updates", machines: facts, run: failed, now }).lines;
  expect(line.find((entry) => entry.id === "studio")?.words).toContain("newer release");
});

test("a machine whose ace predates remote updates, and a kept run that no longer reads, change nothing", () => {
  const old: MachineUpdate | null = null;
  const reply = fleetUpdates({
    type: "fleet.updates",
    machines: [{ id: "old", name: "Old", online: true, access: "admin", update: old }],
    run: { not: "a run" },
    now,
  });
  expect(reply.run).toBeNull();
  expect(reply.headline).toBeNull();
  expect(reply.sends).toEqual([]);
});

test("a kept run past its seven days comes back as no run, so the phone stops watching it", async () => {
  const { facts } = await fleet({ Studio: machine("studio", "0.0.19") });
  const run = fleetRun({ type: "fleet.run", op: "start", mode: "idle", machines: facts, now }).run;
  const later = now + 8 * 24 * 60 * 60 * 1000;
  expect(fleetUpdates({ type: "fleet.updates", machines: facts, run, now }).run).not.toBeNull();
  expect(fleetUpdates({ type: "fleet.updates", machines: facts, run, now: later }).run).toBeNull();
  expect(fleetRun({ type: "fleet.run", op: "sent", run, id: "studio", now: later }).run).toBeNull();
});
